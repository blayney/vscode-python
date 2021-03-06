// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';
import '../common/extensions';

import { nbformat } from '@jupyterlab/coreutils';
import {
    Contents,
    ContentsManager,
    Kernel,
    KernelMessage,
    ServerConnection,
    Session,
    SessionManager
} from '@jupyterlab/services';
import { Slot } from '@phosphor/signaling';
import * as fs from 'fs-extra';
import { inject, injectable } from 'inversify';
import * as os from 'os';
import { Observable } from 'rxjs/Observable';
import { Subscriber } from 'rxjs/Subscriber';
import * as vscode from 'vscode';
import { CancellationToken } from 'vscode-jsonrpc';

import { IWorkspaceService } from '../common/application/types';
import { Cancellation, CancellationError } from '../common/cancellation';
import { IAsyncDisposableRegistry, IDisposable, IDisposableRegistry, ILogger } from '../common/types';
import { createDeferred, Deferred, sleep } from '../common/utils/async';
import * as localize from '../common/utils/localize';
import { noop } from '../common/utils/misc';
import { generateCells } from './cellFactory';
import { concatMultilineString } from './common';
import { CellState, ICell, IConnection, IJupyterKernelSpec, INotebookServer, InterruptResult } from './types';

class CellSubscriber {
    private deferred : Deferred<CellState> = createDeferred<CellState>();
    private cellRef: ICell;
    private subscriber: Subscriber<ICell>;
    private promiseComplete: (self: CellSubscriber) => void;
    private startTime: number;

    constructor(cell: ICell, subscriber: Subscriber<ICell>, promiseComplete: (self: CellSubscriber) => void) {
        this.cellRef = cell;
        this.subscriber = subscriber;
        this.promiseComplete = promiseComplete;
        this.startTime = Date.now();
    }

    public isValid(sessionStartTime: number | undefined) {
        return sessionStartTime && this.startTime > sessionStartTime;
    }

    public next(sessionStartTime:  number | undefined) {
        // Tell the subscriber first
        if (this.isValid(sessionStartTime)) {
            this.subscriber.next(this.cellRef);
        }

        // Then see if we're finished or not.
        this.attemptToFinish();
    }

    // tslint:disable-next-line:no-any
    public error(sessionStartTime: number | undefined, err: any) {
        if (this.isValid(sessionStartTime)) {
            this.subscriber.error(err);
        }
    }

    public complete(sessionStartTime: number | undefined) {
        if (this.isValid(sessionStartTime)) {
            this.subscriber.next(this.cellRef);
        }
        this.subscriber.complete();

        // Then see if we're finished or not.
        this.attemptToFinish();
    }

    public reject() {
        if (!this.deferred.completed) {
            this.cellRef.state = CellState.error;
            this.subscriber.next(this.cellRef);
            this.subscriber.complete();
            this.deferred.reject();
            this.promiseComplete(this);
        }
    }

    public get promise() : Promise<CellState> {
        return this.deferred.promise;
    }

    public get cell() : ICell {
        return this.cellRef;
    }

    private attemptToFinish() {
        if ((!this.deferred.completed) &&
            (this.cell.state === CellState.finished || this.cell.state === CellState.error)) {
            this.deferred.resolve(this.cell.state);
            this.promiseComplete(this);
        }
    }
}

// This code is based on the examples here:
// https://www.npmjs.com/package/@jupyterlab/services

@injectable()
export class JupyterServer implements INotebookServer, IDisposable {
    private connInfo: IConnection | undefined;
    private kernelSpec: IJupyterKernelSpec | undefined;
    private workingDir: string | undefined;
    private session: Session.ISession | undefined;
    private sessionManager : SessionManager | undefined;
    private contentsManager: ContentsManager | undefined;
    private notebookFile: Contents.IModel | undefined;
    private sessionStartTime: number | undefined;
    private onStatusChangedEvent : vscode.EventEmitter<boolean> = new vscode.EventEmitter<boolean>();
    private pendingCellSubscriptions: CellSubscriber[] = [];
    private ranInitialSetup = false;

    constructor(
        @inject(ILogger) private logger: ILogger,
        @inject(IWorkspaceService) private workspaceService: IWorkspaceService,
        @inject(IDisposableRegistry) private disposableRegistry: IDisposableRegistry,
        @inject(IAsyncDisposableRegistry) private asyncRegistry: IAsyncDisposableRegistry) {
        this.disposableRegistry.push(this);
        this.asyncRegistry.push(this);
    }

    public connect = async (connInfo: IConnection, kernelSpec: IJupyterKernelSpec, cancelToken?: CancellationToken, workingDir?: string) : Promise<void> => {
        // Save connection information so we can use it later during shutdown
        this.connInfo = connInfo;
        this.kernelSpec = kernelSpec;
        this.workingDir = workingDir;

        // First connect to the sesssion manager
        const serverSettings = ServerConnection.makeSettings(
            {
                baseUrl: connInfo.baseUrl,
                token: connInfo.token,
                pageUrl: '',
                // A web socket is required to allow token authentication
                wsUrl: connInfo.baseUrl.replace('http', 'ws'),
                init: { cache: 'no-store', credentials: 'same-origin' }
            });
        this.sessionManager = new SessionManager({ serverSettings: serverSettings });

        // Create a temporary .ipynb file to use
        this.contentsManager = new ContentsManager({ serverSettings: serverSettings });
        this.notebookFile = await this.contentsManager.newUntitled({type: 'notebook'});

        // Create our session options using this temporary notebook and our connection info
        const options: Session.IOptions = {
            path: this.notebookFile.path,
            kernelName: kernelSpec ? kernelSpec.name : '',
            serverSettings: serverSettings
        };

        // Start a new session
        this.session = await Cancellation.race(() => this.sessionManager!.startNew(options), cancelToken);

        // Setup our start time. We reject anything that comes in before this time during execute
        this.sessionStartTime = Date.now();

        // Wait for it to be ready
        await this.session.kernel.ready;

        // Run our initial setup and plot magics
        this.initialNotebookSetup(cancelToken);
    }

    public shutdown = async () : Promise<void> => {
        // Destroy the kernel spec first. It's the key thing to
        // finish.
        await this.destroyKernelSpec();

        // Destroy the notebook file if not local. Local is cleaned up when we destroy the kernel spec.
        if (this.notebookFile && this.contentsManager && this.connInfo && !this.connInfo.localLaunch) {
            try {
                await this.contentsManager.delete(this.notebookFile.path);
            } catch {
                noop();
            }
        }
        await this.shutdownSessionAndConnection();
    }

    public dispose = () : Promise<void> => {
        return this.shutdown();
    }

    public waitForIdle = async () : Promise<void> => {
        if (this.session && this.session.kernel) {
            await this.session.kernel.ready;

            while (this.session.kernel.status !== 'idle') {
                await this.timeout(0);
            }
        }
    }

    public getCurrentState() : Promise<ICell[]> {
        return Promise.resolve([]);
    }

    public execute(code : string, file: string, line: number, cancelToken?: CancellationToken) : Promise<ICell[]> {
        // Do initial setup if necessary
        this.initialNotebookSetup();

        // Create a deferred that we'll fire when we're done
        const deferred = createDeferred<ICell[]>();

        // Attempt to evaluate this cell in the jupyter notebook
        const observable = this.executeObservable(code, file, line);
        let output: ICell[];

        observable.subscribe(
            (cells: ICell[]) => {
                output = cells;
            },
            (error) => {
                deferred.reject(error);
            },
            () => {
                deferred.resolve(output);
            });

        if (cancelToken) {
            this.disposableRegistry.push(cancelToken.onCancellationRequested(() => deferred.reject(new CancellationError())));
        }

        // Wait for the execution to finish
        return deferred.promise;
    }

    public setInitialDirectory = async (directory: string): Promise<void> => {
        // If we launched local and have no working directory call this on add code to change directory
        if (!this.workingDir && this.connInfo && this.connInfo.localLaunch) {
            await this.changeDirectoryIfPossible(directory);
            this.workingDir = directory;
        }
    }

    public executeObservable = (code: string, file: string, line: number) : Observable<ICell[]> => {
        // Do initial setup if necessary
        this.initialNotebookSetup();

        // If we have a session, execute the code now.
        if (this.session) {
            // Generate our cells ahead of time
            const cells = generateCells(code, file, line);

            // Might have more than one (markdown might be split)
            if (cells.length > 1) {
                // We need to combine results
                return this.combineObservables(
                    this.executeMarkdownObservable(cells[0]),
                    this.executeCodeObservable(cells[1]));
            } else if (cells.length > 0) {
                // Either markdown or or code
                return this.combineObservables(
                    cells[0].data.cell_type === 'code' ? this.executeCodeObservable(cells[0]) : this.executeMarkdownObservable(cells[0]));
            }
        }

        // Can't run because no session
        return new Observable<ICell[]>(subscriber => {
            subscriber.error(new Error(localize.DataScience.sessionDisposed()));
            subscriber.complete();
        });
    }

    public executeSilently = (code: string, cancelToken?: CancellationToken) : Promise<void> => {
        return new Promise((resolve, reject) => {

            // If we cancel, reject our promise
            if (cancelToken) {
                this.disposableRegistry.push(cancelToken.onCancellationRequested(() => reject(new CancellationError())));
            }

            // Do initial setup if necessary
            this.initialNotebookSetup();

            // If we have a session, execute the code now.
            if (this.session) {
                // Generate a new request and resolve when it's done.
                const request = this.generateRequest(code, true);

                if (request) {
                    // // For debugging purposes when silently is failing.
                    // request.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
                    //     try {
                    //         this.logger.logInformation(`Execute silently message ${msg.header.msg_type} : hasData=${'data' in msg.content}`);
                    //     } catch (err) {
                    //         this.logger.logError(err);
                    //     }
                    // };

                    request.done.then(() => {
                        this.logger.logInformation(`Execute for ${code} silently finished.`);
                        resolve();
                    }).catch(reject);
                } else {
                    reject(new Error(localize.DataScience.sessionDisposed()));
                }
            } else {
                reject(new Error(localize.DataScience.sessionDisposed()));
            }
        });
    }

    public get onStatusChanged() : vscode.Event<boolean> {
        return this.onStatusChangedEvent.event.bind(this.onStatusChangedEvent);
    }

    public restartKernel = async () : Promise<void> => {
        if (this.session && this.session.kernel) {
            // Update our start time so we don't keep sending responses
            this.sessionStartTime = Date.now();

            // Complete all pending as an error. We're restarting
            const copyPending = [...this.pendingCellSubscriptions];
            copyPending.forEach(c => c.reject());

            // Restart our kernel
            await this.session.kernel.restart();

            // Rerun our initial setup for the notebook
            this.ranInitialSetup = false;
            this.initialNotebookSetup();

            return;
        }

        throw new Error(localize.DataScience.sessionDisposed());
    }

    public interruptKernel = async (timeoutMs: number) : Promise<InterruptResult> => {
        if (this.session && this.session.kernel) {
            // Keep track of our current time. If our start time gets reset, we
            // restarted the kernel.
            const interruptBeginTime = Date.now();

            // Copy the list of pending cells. If these don't finish before the timeout
            // then our interrupt didn't work.
            const copyPending = [...this.pendingCellSubscriptions];

            // Create a promise that resolves when all of our currently
            // pending cells finish.
            const finished = copyPending.length > 0 ?
                Promise.all(copyPending.map(d => d.promise)) : Promise.resolve([CellState.finished]);

            // Create a deferred promise that resolves if we have a failure
            const restarted = createDeferred<CellState[]>();

            // Listen to status change events so we can tell if we're restarting
            const statusHandler: Slot<Session.ISession, Kernel.Status> = (s, a) => {
                if (a === 'starting') {
                    // We restarted the kernel.
                    this.sessionStartTime = Date.now();
                    this.logger.logWarning('Kernel restarting during interrupt');

                    // Indicate we have to redo initial setup. We can't wait for starting though
                    // because sometimes it doesn't happen
                    this.ranInitialSetup = false;

                    // Indicate we restarted the race below
                    restarted.resolve([]);

                    // Fail all of the active (might be new ones) pending cell executes. We restarted.
                    const newCopyPending = [...this.pendingCellSubscriptions];
                    newCopyPending.forEach(c => {
                        c.reject();
                    });
                }
            };
            this.session.statusChanged.connect(statusHandler);

            // Start our interrupt. If it fails, indicate a restart
            this.session.kernel.interrupt().catch(exc => {
                this.logger.logWarning(`Error during interrupt: ${exc}`);
                restarted.resolve([]);
            });

            try {
                // Wait for all of the pending cells to finish or the timeout to fire
                const result = await Promise.race([finished, restarted.promise, sleep(timeoutMs)]);
                const states = result as CellState[];

                // See if we restarted or not
                if (restarted.completed) {
                    return InterruptResult.Restarted;
                }

                if (states) {
                    // We got back the pending cells
                    return InterruptResult.Success;
                }

                // We timed out. You might think we should stop our pending list, but that's not
                // up to us. The cells are still executing. The user has to request a restart or try again
                return InterruptResult.TimedOut;
            } catch (exc) {
                // Something failed. See if we restarted or not.
                if (interruptBeginTime < this.sessionStartTime) {
                    return InterruptResult.Restarted;
                }

                // Otherwise a real error occurred.
                throw exc;
            } finally {
                this.session.statusChanged.disconnect(statusHandler);
            }
        }

        throw new Error(localize.DataScience.sessionDisposed());
    }

    private shutdownSessionAndConnection = async () => {
        if (this.contentsManager) {
            this.contentsManager.dispose();
            this.contentsManager = undefined;
        }
        if (this.session || this.sessionManager) {
            try {
                if (this.session) {
                    await this.session.shutdown();
                    this.session.dispose();
                }
                if (this.sessionManager) {
                    this.sessionManager.dispose();
                }
            } catch {
                noop();
            }
            this.session = undefined;
            this.sessionManager = undefined;
        }
        this.onStatusChangedEvent.dispose();
        if (this.connInfo) {
            this.connInfo.dispose(); // This should kill the process that's running
            this.connInfo = undefined;
        }
    }

    private destroyKernelSpec = async () => {
        try {
            if (this.kernelSpec) {
                await this.kernelSpec.dispose(); // This should delete any old kernel specs
            }
        } catch {
            noop();
        }
        this.kernelSpec = undefined;
    }

    private generateRequest = (code: string, silent: boolean) : Kernel.IFuture | undefined => {
        //this.logger.logInformation(`Executing code in jupyter : ${code}`)
        return this.session ? this.session.kernel.requestExecute(
            {
                // Replace windows line endings with unix line endings.
                code: code.replace(/\r\n/g, '\n'),
                stop_on_error: false,
                allow_stdin: false,
                silent: silent
            },
            true
        ) : undefined;
    }

    // Set up our initial plotting and imports
    private initialNotebookSetup = (cancelToken?: CancellationToken) => {
        if (this.ranInitialSetup) {
            return;
        }
        this.ranInitialSetup = true;

        // When we start our notebook initial, change to our workspace or user specified root directory
        if (this.connInfo && this.connInfo.localLaunch && this.workingDir) {
            this.changeDirectoryIfPossible(this.workingDir).ignoreErrors();
        }

        // Check for dark theme, if so set matplot lib to use dark_background settings
        let darkTheme: boolean = false;
        const workbench = this.workspaceService.getConfiguration('workbench');
        if (workbench) {
            const theme = workbench.get<string>('colorTheme');
            if (theme) {
                darkTheme = /dark/i.test(theme);
            }
        }

        this.executeSilently(
            `%matplotlib inline${os.EOL}import matplotlib.pyplot as plt${darkTheme ? `${os.EOL}from matplotlib import style${os.EOL}style.use(\'dark_background\')` : ''}`,
            cancelToken
        ).ignoreErrors();
    }

    private timeout(ms : number) : Promise<number> {
        return new Promise(resolve => setTimeout(resolve, ms, ms));
    }

    private combineObservables = (...args : Observable<ICell>[]) : Observable<ICell[]> => {
        return new Observable<ICell[]>(subscriber => {
            // When all complete, we have our results
            const results : { [id : string] : ICell } = {};

            args.forEach(o => {
                o.subscribe(c => {
                    results[c.id] = c;

                    // Convert to an array
                    const array = Object.keys(results).map((k : string) => {
                        return results[k];
                    });

                    // Update our subscriber of our total results if we have that many
                    if (array.length === args.length) {
                        subscriber.next(array);

                        // Complete when everybody is finished
                        if (array.every(a => a.state === CellState.finished || a.state === CellState.error)) {
                            subscriber.complete();
                        }
                    }
                },
                e => {
                    subscriber.error(e);
                });
            });
        });
    }

    private executeMarkdownObservable = (cell: ICell) : Observable<ICell> => {
        // Markdown doesn't need any execution
        return new Observable<ICell>(subscriber => {
            subscriber.next(cell);
            subscriber.complete();
        });
    }

    private changeDirectoryIfPossible = async (directory: string) : Promise<void> => {
        if (this.connInfo && this.connInfo.localLaunch && await fs.pathExists(directory)) {
            await this.executeSilently(`%cd "${directory}"`);
        }
    }

    private handleCodeRequest = (subscriber: CellSubscriber) => {
        // Generate a new request if we still can
        if (subscriber.isValid(this.sessionStartTime)) {

            const request = this.generateRequest(concatMultilineString(subscriber.cell.data.source), false);

            // tslint:disable-next-line:no-require-imports
            const jupyterLab = require('@jupyterlab/services') as typeof import('@jupyterlab/services');

            // Transition to the busy stage
            subscriber.cell.state = CellState.executing;

            // Listen to the reponse messages and update state as we go
            if (request) {
                request.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
                    try {
                        if (jupyterLab.KernelMessage.isExecuteResultMsg(msg)) {
                            this.handleExecuteResult(msg as KernelMessage.IExecuteResultMsg, subscriber.cell);
                        } else if (jupyterLab.KernelMessage.isExecuteInputMsg(msg)) {
                            this.handleExecuteInput(msg as KernelMessage.IExecuteInputMsg, subscriber.cell);
                        } else if (jupyterLab.KernelMessage.isStatusMsg(msg)) {
                            this.handleStatusMessage(msg as KernelMessage.IStatusMsg, subscriber.cell);
                        } else if (jupyterLab.KernelMessage.isStreamMsg(msg)) {
                            this.handleStreamMesssage(msg as KernelMessage.IStreamMsg, subscriber.cell);
                        } else if (jupyterLab.KernelMessage.isDisplayDataMsg(msg)) {
                            this.handleDisplayData(msg as KernelMessage.IDisplayDataMsg, subscriber.cell);
                        } else if (jupyterLab.KernelMessage.isErrorMsg(msg)) {
                            this.handleError(msg as KernelMessage.IErrorMsg, subscriber.cell);
                        } else {
                            this.logger.logWarning(`Unknown message ${msg.header.msg_type} : hasData=${'data' in msg.content}`);
                        }

                        // Set execution count, all messages should have it
                        if (msg.content.execution_count) {
                            subscriber.cell.data.execution_count = msg.content.execution_count as number;
                        }

                        // Show our update if any new output
                        subscriber.next(this.sessionStartTime);
                    } catch (err) {
                        // If not a restart error, then tell the subscriber
                        subscriber.error(this.sessionStartTime, err);
                    }
                };

                // When the request finishes we are done
                request.done.then(() => subscriber.complete(this.sessionStartTime)).catch(e => subscriber.error(this.sessionStartTime, e));
            } else {
                subscriber.error(this.sessionStartTime, new Error(localize.DataScience.sessionDisposed()));
            }
        } else {
            // Otherwise just set to an error
            this.handleInterrupted(subscriber.cell);
            subscriber.cell.state = CellState.error;
            subscriber.complete(this.sessionStartTime);
        }

    }

    private executeCodeObservable(cell: ICell) : Observable<ICell> {
        return new Observable<ICell>(subscriber => {
            // Tell our listener. NOTE: have to do this asap so that markdown cells don't get
            // run before our cells.
            subscriber.next(cell);

            // Wrap the subscriber and save it. It is now pending and waiting completion.
            const cellSubscriber = new CellSubscriber(cell, subscriber, (self: CellSubscriber) => {
                this.pendingCellSubscriptions = this.pendingCellSubscriptions.filter(p => p !== self);
            });
            this.pendingCellSubscriptions.push(cellSubscriber);

            // Attempt to change to the current directory. When that finishes
            // send our real request
            this.handleCodeRequest(cellSubscriber);
        });
    }

    private addToCellData = (cell: ICell, output : nbformat.IUnrecognizedOutput | nbformat.IExecuteResult | nbformat.IDisplayData | nbformat.IStream | nbformat.IError) => {
        const data : nbformat.ICodeCell = cell.data as nbformat.ICodeCell;
        data.outputs = [...data.outputs, output];
        cell.data = data;
    }

    private handleExecuteResult(msg: KernelMessage.IExecuteResultMsg, cell: ICell) {
        this.addToCellData(cell, { output_type : 'execute_result', data: msg.content.data, metadata : msg.content.metadata, execution_count : msg.content.execution_count });
    }

    private handleExecuteInput(msg: KernelMessage.IExecuteInputMsg, cell: ICell) {
        cell.data.execution_count = msg.content.execution_count;
    }

    private handleStatusMessage(msg: KernelMessage.IStatusMsg, cell: ICell) {
        if (msg.content.execution_state === 'busy') {
            this.onStatusChangedEvent.fire(true);
        } else {
            this.onStatusChangedEvent.fire(false);
        }

        // Status change to idle generally means we finished. Not sure how to
        // make sure of this. Maybe only bother if an interrupt
        if (msg.content.execution_state === 'idle' && cell.state !== CellState.error) {
            cell.state = CellState.finished;
        }
    }

    private handleStreamMesssage(msg: KernelMessage.IStreamMsg, cell: ICell) {
        const output : nbformat.IStream = {
            output_type : 'stream',
            name : msg.content.name,
            text : msg.content.text
        };
        this.addToCellData(cell, output);
    }

    private handleDisplayData(msg: KernelMessage.IDisplayDataMsg, cell: ICell) {
        const output : nbformat.IDisplayData = {
            output_type : 'display_data',
            data: msg.content.data,
            metadata : msg.content.metadata
        };
        this.addToCellData(cell, output);
    }

    private handleInterrupted(cell : ICell) {
        this.handleError({
            channel: 'iopub',
            parent_header: {},
            metadata: {},
            header: { username: '', version: '', session: '', msg_id: '', msg_type: 'error' },
            content: {
                ename: 'KeyboardInterrupt',
                evalue: '',
                // Does this need to be translated? All depends upon if jupyter does or not
                traceback: [
                    '[1;31m---------------------------------------------------------------------------[0m',
                    '[1;31mKeyboardInterrupt[0m: '
                ]
            }
        }, cell);
    }

    private handleError(msg: KernelMessage.IErrorMsg, cell: ICell) {
        const output : nbformat.IError = {
            output_type : 'error',
            ename : msg.content.ename,
            evalue : msg.content.evalue,
            traceback : msg.content.traceback
        };
        this.addToCellData(cell, output);
        cell.state = CellState.error;
    }
}
