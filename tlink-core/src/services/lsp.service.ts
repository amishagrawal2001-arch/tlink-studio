/**
 * Minimal Language Server Protocol client.
 *
 * Spawns a language server as a child process over stdio, speaks JSON-RPC
 * per the LSP spec (Content-Length framed), and surfaces diagnostics,
 * completion, and hover to Monaco through regular editor providers.
 *
 * This is intentionally dependency-free — electron's child_process is enough
 * for stdio transport, and the LSP wire format is simple. For production use
 * cases that need file watching, workspace folders, go-to-def across files,
 * swap this for `monaco-languageclient`.
 */

export interface LspServerSpec {
    language: string          // Monaco language id (e.g. 'python', 'typescript')
    command: string           // binary name or absolute path
    args?: string[]
    extensions?: string[]     // file extensions this server handles (e.g. ['.py'])
    initializationOptions?: any
}

interface PendingRequest {
    resolve: (value: any) => void
    reject: (err: any) => void
}

interface ServerInstance {
    spec: LspServerSpec
    child: any
    nextId: number
    pending: Map<number, PendingRequest>
    buffer: Buffer
    initialized: boolean
    openUris: Set<string>
    diagnosticsListeners: Set<(uri: string, diagnostics: any[]) => void>
    documentVersion: Map<string, number>
    closed: boolean
}

type SpawnFn = (cmd: string, args: string[], opts: any) => any

export class LspService {
    private servers = new Map<string, ServerInstance>()  // keyed by language id
    private childProcess: { spawn: SpawnFn } | null = null
    private configs: LspServerSpec[] = []
    private spawnErrors = new Set<string>()

    constructor () {
        try {
            this.childProcess = (window as any).require?.('child_process')
        } catch { /* non-electron, no LSP */ }
    }

    isAvailable (): boolean { return !!this.childProcess }

    setConfigs (configs: LspServerSpec[]): void {
        this.configs = configs
        // Shut down any running servers whose config was removed
        for (const [lang, inst] of this.servers.entries()) {
            if (!configs.find(c => c.language === lang)) {
                this.shutdown(inst)
                this.servers.delete(lang)
            }
        }
    }

    getConfigs (): LspServerSpec[] { return this.configs.slice() }

    findConfigForLanguage (langId: string): LspServerSpec | undefined {
        return this.configs.find(c => c.language === langId)
    }

    serverStatus (langId: string): 'running' | 'failed' | 'off' {
        if (this.spawnErrors.has(langId)) { return 'failed' }
        const inst = this.servers.get(langId)
        if (inst && !inst.closed && inst.initialized) { return 'running' }
        return 'off'
    }

    onDiagnostics (langId: string, listener: (uri: string, diagnostics: any[]) => void): () => void {
        void this.ensureServer(langId)
        const inst = this.servers.get(langId)
        if (inst) { inst.diagnosticsListeners.add(listener) }
        return () => {
            const i = this.servers.get(langId)
            i?.diagnosticsListeners.delete(listener)
        }
    }

    async openDocument (langId: string, uri: string, text: string): Promise<void> {
        const inst = await this.ensureServer(langId)
        if (!inst) { return }
        inst.openUris.add(uri)
        inst.documentVersion.set(uri, 1)
        this.notify(inst, 'textDocument/didOpen', {
            textDocument: { uri, languageId: langId, version: 1, text },
        })
    }

    async changeDocument (langId: string, uri: string, text: string): Promise<void> {
        const inst = this.servers.get(langId)
        if (!inst || !inst.initialized || !inst.openUris.has(uri)) { return }
        const nextVer = (inst.documentVersion.get(uri) ?? 1) + 1
        inst.documentVersion.set(uri, nextVer)
        this.notify(inst, 'textDocument/didChange', {
            textDocument: { uri, version: nextVer },
            contentChanges: [{ text }],
        })
    }

    async closeDocument (langId: string, uri: string): Promise<void> {
        const inst = this.servers.get(langId)
        if (!inst || !inst.openUris.has(uri)) { return }
        inst.openUris.delete(uri)
        inst.documentVersion.delete(uri)
        this.notify(inst, 'textDocument/didClose', { textDocument: { uri } })
    }

    async completion (langId: string, uri: string, line: number, character: number): Promise<any> {
        const inst = this.servers.get(langId)
        if (!inst?.initialized) { return null }
        return this.request(inst, 'textDocument/completion', {
            textDocument: { uri }, position: { line, character },
        })
    }

    async hover (langId: string, uri: string, line: number, character: number): Promise<any> {
        const inst = this.servers.get(langId)
        if (!inst?.initialized) { return null }
        return this.request(inst, 'textDocument/hover', {
            textDocument: { uri }, position: { line, character },
        })
    }

    async definition (langId: string, uri: string, line: number, character: number): Promise<any> {
        const inst = this.servers.get(langId)
        if (!inst?.initialized) { return null }
        return this.request(inst, 'textDocument/definition', {
            textDocument: { uri }, position: { line, character },
        })
    }

    shutdownAll (): void {
        for (const inst of this.servers.values()) { this.shutdown(inst) }
        this.servers.clear()
    }

    private async ensureServer (langId: string): Promise<ServerInstance | null> {
        const existing = this.servers.get(langId)
        if (existing && !existing.closed) { return existing }
        if (this.spawnErrors.has(langId)) { return null }
        const config = this.findConfigForLanguage(langId)
        if (!config || !this.childProcess) { return null }
        try {
            const child = this.childProcess.spawn(config.command, config.args ?? [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            })
            const inst: ServerInstance = {
                spec: config,
                child,
                nextId: 1,
                pending: new Map(),
                buffer: Buffer.alloc(0),
                initialized: false,
                openUris: new Set(),
                diagnosticsListeners: new Set(),
                documentVersion: new Map(),
                closed: false,
            }
            this.servers.set(langId, inst)
            child.stdout?.on('data', (data: Buffer) => this.onServerData(inst, data))
            child.stderr?.on('data', () => { /* ignore stderr noise */ })
            child.on('error', () => {
                this.spawnErrors.add(langId)
                inst.closed = true
            })
            child.on('exit', () => { inst.closed = true })
            await this.initialize(inst)
            return inst
        } catch {
            this.spawnErrors.add(langId)
            return null
        }
    }

    private async initialize (inst: ServerInstance): Promise<void> {
        try {
            const result = await this.request(inst, 'initialize', {
                processId: process.pid,
                rootUri: null,
                capabilities: {
                    textDocument: {
                        synchronization: { didSave: false, willSave: false },
                        completion: { completionItem: { snippetSupport: true } },
                        hover: {},
                        publishDiagnostics: {},
                    },
                },
                initializationOptions: inst.spec.initializationOptions ?? {},
            })
            void result
            this.notify(inst, 'initialized', {})
            inst.initialized = true
        } catch {
            inst.closed = true
        }
    }

    private shutdown (inst: ServerInstance): void {
        if (inst.closed) { return }
        try { this.notify(inst, 'exit', null) } catch { /* ignore */ }
        try { inst.child?.kill?.() } catch { /* ignore */ }
        inst.closed = true
    }

    private send (inst: ServerInstance, msg: any): void {
        if (inst.closed || !inst.child?.stdin?.writable) { return }
        const json = JSON.stringify(msg)
        const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`
        try { inst.child.stdin.write(header + json, 'utf8') } catch { /* ignore */ }
    }

    private notify (inst: ServerInstance, method: string, params: any): void {
        this.send(inst, { jsonrpc: '2.0', method, params })
    }

    private request (inst: ServerInstance, method: string, params: any): Promise<any> {
        return new Promise((resolve, reject) => {
            if (inst.closed) { reject(new Error('server closed')); return }
            const id = inst.nextId++
            inst.pending.set(id, { resolve, reject })
            this.send(inst, { jsonrpc: '2.0', id, method, params })
            setTimeout(() => {
                if (inst.pending.has(id)) {
                    inst.pending.delete(id)
                    reject(new Error('LSP request timeout'))
                }
            }, 8000)
        })
    }

    private onServerData (inst: ServerInstance, chunk: Buffer): void {
        inst.buffer = Buffer.concat([inst.buffer, chunk])
        // Parse one or more Content-Length framed messages
        while (true) {
            const headerEnd = inst.buffer.indexOf('\r\n\r\n')
            if (headerEnd < 0) { break }
            const header = inst.buffer.slice(0, headerEnd).toString('utf8')
            const match = /Content-Length: (\d+)/i.exec(header)
            if (!match) {
                // Malformed; drop buffer
                inst.buffer = Buffer.alloc(0)
                break
            }
            const contentLength = parseInt(match[1], 10)
            const total = headerEnd + 4 + contentLength
            if (inst.buffer.length < total) { break }
            const body = inst.buffer.slice(headerEnd + 4, total).toString('utf8')
            inst.buffer = inst.buffer.slice(total)
            try {
                this.handleMessage(inst, JSON.parse(body))
            } catch { /* ignore malformed */ }
        }
    }

    private handleMessage (inst: ServerInstance, msg: any): void {
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = inst.pending.get(msg.id)
            if (!pending) { return }
            inst.pending.delete(msg.id)
            if (msg.error) { pending.reject(msg.error) }
            else { pending.resolve(msg.result) }
            return
        }
        if (msg.method === 'textDocument/publishDiagnostics') {
            const { uri, diagnostics } = msg.params ?? {}
            for (const l of inst.diagnosticsListeners) {
                try { l(uri, diagnostics ?? []) } catch { /* ignore */ }
            }
        }
        // Ignore server-to-client requests we can't handle (e.g. workspace/configuration).
        // Many servers tolerate missing responses; those that don't will degrade gracefully.
    }
}

export const DEFAULT_LSP_CONFIGS: LspServerSpec[] = [
    { language: 'python', command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py'] },
    { language: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx'] },
    { language: 'javascript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.js', '.jsx'] },
    { language: 'go', command: 'gopls', args: ['serve'], extensions: ['.go'] },
    { language: 'rust', command: 'rust-analyzer', args: [], extensions: ['.rs'] },
]
