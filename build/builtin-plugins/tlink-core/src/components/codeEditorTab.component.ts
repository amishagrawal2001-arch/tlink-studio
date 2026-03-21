import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostBinding, HostListener, Injector, ViewChild, Optional } from '@angular/core'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import * as os from 'os'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'

import { BaseTabComponent, DirectoryUpload, FileUpload, GetRecoveryTokenOptions, PlatformService, RecoveryToken, SelectorOption } from '../api'
import { AppService } from '../services/app.service'
import { TabsService } from '../services/tabs.service'
import { ProfilesService } from '../services/profiles.service'
import { SplitTabComponent } from './splitTab.component'
type TerminalServiceType = any
type BaseTerminalTabComponentType = any
import { PromptModalComponent } from './promptModal.component'

type Monaco = any

interface EditorDocumentSnapshot {
    name: string
    path: string|null
    tempPath?: string|null
    folderPath?: string|null
    content: string
    languageId: string
    eol: 'LF'|'CRLF'
    tabSize: number
    insertSpaces: boolean
    isDirty?: boolean
    lastSavedValue?: string
}

interface EditorDocument extends EditorDocumentSnapshot {
    id: string
    model: any
    /** Disposable subscriptions (model listeners) – call .dispose() to clean up. */
    modelDisposables: { dispose(): void }[]
    tempPath?: string|null
    folderPath?: string|null
    isDirty: boolean
    lastSavedValue: string
    ansiDecorationIds: string[]
    diskMtimeMs?: number|null
    diskSize?: number|null
    externalConflict?: ExternalConflictState|null
}

type ViewMode = 'editor'|'diff'
type EditorThemeMode = 'auto'|'light'|'dark'|'hc'|'solarized-light'|'solarized-dark'|'dracula'|'monokai'|'nord'
type FolderTreeMode = 'full'|'opened'
interface TreeNode {
    name: string
    path: string
    isFolder: boolean
    children: TreeNode[]
    docId?: string|null
    folderPath?: string|null
}
interface CodeFolder {
    name: string
    path: string
}

interface TreeBuildResult {
    roots: TreeNode[]
    truncated: boolean
}

interface QuickOpenSelection {
    kind: 'doc'|'file'
    docId?: string
    filePath?: string
}

interface ExternalConflictState {
    diskContent: string
    diskMtimeMs: number
    diskSize: number
}

interface EditorStateFilePayload {
    version: number
    updatedAt: string
    values: Record<string, string>
}

interface TopologyNodeModel {
    id: string
    type: string
    label: string
    x: number
    y: number
    width?: number
    height?: number
    color?: string
}

type TopologyLinkEndpointKind = 'node'|'shape'
type TopologyLinkStyle = 'line'|'arrow'|'double'
type TopologyInlineEditKind = 'node'|'link'|'shape'|'text'

interface TopologyLinkModel {
    id: string
    from?: string
    to?: string
    fromKind?: TopologyLinkEndpointKind
    toKind?: TopologyLinkEndpointKind
    x1?: number
    y1?: number
    x2?: number
    y2?: number
    label?: string
    labelOffsetX?: number
    labelOffsetY?: number
    color?: string
    directed?: boolean
    bidirectional?: boolean
    labels?: TopologyLinkLabelModel[]
}

interface TopologyLinkLabelModel {
    id: string
    text: string
    offsetX?: number
    offsetY?: number
    offsetAlong?: number
    offsetNormal?: number
}

interface TopologyShapeModel {
    id: string
    kind: 'circle'|'oval'
    x: number
    y: number
    width: number
    height: number
    label?: string
    color?: string
}

interface TopologyTextModel {
    id: string
    text: string
    x: number
    y: number
    sticky?: boolean
    collapsed?: boolean
    width?: number
    height?: number
    color?: string
}

interface TopologyDocumentModel {
    schemaVersion: string
    type: string
    name: string
    nodes: TopologyNodeModel[]
    links: TopologyLinkModel[]
    shapes: TopologyShapeModel[]
    texts: TopologyTextModel[]
    metadata?: Record<string, unknown>
    [key: string]: unknown
}

interface TopologyNodeClipboardData {
    nodes: TopologyNodeModel[]
    shapes: TopologyShapeModel[]
    texts: TopologyTextModel[]
    links: TopologyLinkModel[]
}

interface TopologyRestorePoint {
    timestamp: number
    serialized: string
}

interface TopologyLinkRenderItem {
    id: string
    path: string
    labels: TopologyLinkRenderLabelItem[]
    baseLabelX: number
    baseLabelY: number
    dirX: number
    dirY: number
    normalX: number
    normalY: number
    startX: number
    startY: number
    endX: number
    endY: number
    isFree: boolean
    color?: string
    directed: boolean
    bidirectional: boolean
}

interface TopologyLinkRenderLabelItem {
    id: string
    text: string
    labelX: number
    labelY: number
    baseLabelX: number
    baseLabelY: number
}

interface TopologyColorOption {
    label: string
    value: string
}

@Component({
    selector: 'code-editor-tab',
    templateUrl: './codeEditorTab.component.pug',
    styleUrls: ['./codeEditorTab.component.scss'],
})
export class CodeEditorTabComponent extends BaseTabComponent implements AfterViewInit {
    private static globalMonacoPromise?: Promise<Monaco>
    private static globalMonacoAmdRequire?: any
    private static monacoQuickPickGuardInstalled = false
    @HostBinding('class.code-editor-tab') hostClass = true
    @HostBinding('class.platform-darwin') platformClassMacOS = process.platform === 'darwin'
    @HostBinding('style.--tlink-editor-selection-rgb')
    get editorSelectionRgb (): string {
        const rgb = this.hexToRgb(this.editorThemeColor)
        if (!rgb) {
            return '79, 156, 255'
        }
        return `${rgb.r}, ${rgb.g}, ${rgb.b}`
    }
    @ViewChild('primaryHost', { static: true }) primaryHost?: ElementRef<HTMLDivElement>
    @ViewChild('splitHost', { static: true }) splitHost?: ElementRef<HTMLDivElement>
    @ViewChild('diffHost', { static: true }) diffHost?: ElementRef<HTMLDivElement>
    @ViewChild('treeList') treeList?: ElementRef<HTMLDivElement>
    @ViewChild('topologyCanvas') topologyCanvas?: ElementRef<HTMLDivElement>

    loading = true
    loadError: string|null = null
    documents: EditorDocument[] = []
    activeDocId: string|null = null
    splitDocId: string|null = null
    cachedActiveDoc: EditorDocument|null = null
    recentFiles: string[] = []
    closedDocuments: EditorDocumentSnapshot[] = []
    editingDocId: string|null = null
    editingDocName = ''
    wordWrapEnabled = false
    minimapEnabled = false
    themeMode: EditorThemeMode = 'auto'
    editorThemeColor = '#4f9cff'
    private readonly syncAppThemeWithEditor = process.env.TLINK_STUDIO_APP === '1' || !!(window as any).__codeEditorFullWindowMode
    private readonly supportedThemeModes: EditorThemeMode[] = [
        'auto',
        'light',
        'dark',
        'hc',
        'solarized-light',
        'solarized-dark',
        'dracula',
        'monokai',
        'nord',
    ]
    readonly editorThemePresets: Array<{ name: string, color: string }> = [
        { name: 'Blue', color: '#4f9cff' },
        { name: 'Sky', color: '#38bdf8' },
        { name: 'Cyan', color: '#06b6d4' },
        { name: 'Teal', color: '#14b8a6' },
        { name: 'Emerald', color: '#22c55e' },
        { name: 'Lime', color: '#84cc16' },
        { name: 'Amber', color: '#f59e0b' },
        { name: 'Gold', color: '#eab308' },
        { name: 'Rose', color: '#f43f5e' },
        { name: 'Red', color: '#ef4444' },
        { name: 'Pink', color: '#ec4899' },
        { name: 'Fuchsia', color: '#d946ef' },
        { name: 'Violet', color: '#8b5cf6' },
        { name: 'Indigo', color: '#6366f1' },
        { name: 'Purple', color: '#a855f7' },
        { name: 'Orange', color: '#f97316' },
        { name: 'Slate', color: '#64748b' },
    ]
    readonly topologyColorPalette: TopologyColorOption[] = [
        { label: 'Ocean Blue', value: '#2563eb' },
        { label: 'Sky Blue', value: '#0ea5e9' },
        { label: 'Teal', value: '#14b8a6' },
        { label: 'Emerald', value: '#10b981' },
        { label: 'Lime', value: '#84cc16' },
        { label: 'Amber', value: '#f59e0b' },
        { label: 'Orange', value: '#f97316' },
        { label: 'Rose', value: '#f43f5e' },
        { label: 'Magenta', value: '#d946ef' },
        { label: 'Violet', value: '#8b5cf6' },
        { label: 'Slate', value: '#64748b' },
        { label: 'Graphite', value: '#334155' },
    ]
    readonly topologyStickyColorPalette: TopologyColorOption[] = [
        { label: 'Pastel Yellow', value: '#fde68a' },
        { label: 'Honey', value: '#facc15' },
        { label: 'Peach', value: '#fdba74' },
        { label: 'Mint', value: '#86efac' },
        { label: 'Sky', value: '#93c5fd' },
        { label: 'Lilac', value: '#c4b5fd' },
        { label: 'Rose', value: '#fda4af' },
        { label: 'Slate', value: '#94a3b8' },
    ]
    fontSize = 14
    lineHeight = 22
    autosaveEnabled = true
    autosaveIntervalMs = 15000
    viewMode: ViewMode = 'editor'
    breadcrumbs: string[] = []
    statusMessage = ''
    sidebarWidth = 240
    private runTerminalTab: BaseTerminalTabComponentType | null = null
    pendingDiffDocId: string|null = null
    fileMenuOpen = false
    editMenuOpen = false
    showDiagnostics = false
    topologyCanvasMode = false
    topologyData: TopologyDocumentModel|null = null
    topologyParseError = ''
    topologySelectedNodeId: string|null = null
    topologySelectedLinkId: string|null = null
    topologySelectedShapeId: string|null = null
    topologySelectedTextId: string|null = null
    topologySelectedNodeIds = new Set<string>()
    topologySelectedLinkIds = new Set<string>()
    topologySelectedShapeIds = new Set<string>()
    topologySelectedTextIds = new Set<string>()
    topologyPendingLinkSourceId: string|null = null
    topologyPendingLinkSourceKind: TopologyLinkEndpointKind|null = null
    topologyFreeLinkPlacementDirected: boolean|null = null
    topologyPendingFreeLinkStart: { x: number, y: number }|null = null
    topologyFreeLinkDraftEnd: { x: number, y: number }|null = null
    topologyFreeLinkCreating = false
    topologyTextPlacementMode = false
    topologyStickyNotePlacementMode = false
    topologyNewLinksDirected = false
    topologyCurvedLinks = true
    topologyZoom = 1
    topologyPanX = 0
    topologyPanY = 0
    topologyMarqueeActive = false
    topologyMarqueeLeftPx = 0
    topologyMarqueeTopPx = 0
    topologyMarqueeWidthPx = 0
    topologyMarqueeHeightPx = 0
    docContextMenuOpen = false
    docContextMenuDocId: string|null = null
    docContextMenuX = 0
    docContextMenuY = 0
    folders: CodeFolder[] = []
    selectedFolderPath: string|null = null
    folderContextMenuOpen = false
    folderContextMenuPath: string|null = null
    folderContextMenuPaths: string[] = []
    folderContextScopeRoot: string|null = null
    folderContextScopeMode: FolderTreeMode = 'full'
    folderContextMenuX = 0
    folderContextMenuY = 0
    fileContextMenuOpen = false
    fileContextMenuPath: string|null = null
    fileContextMenuPaths: string[] = []
    fileContextMenuX = 0
    fileContextMenuY = 0
    topologyContextMenuOpen = false
    topologyContextMenuX = 0
    topologyContextMenuY = 0
    private topologyContextMenuPoint: { x: number, y: number }|null = null
    topologyNodeContextMenuOpen = false
    topologyNodeContextMenuX = 0
    topologyNodeContextMenuY = 0
    private topologyNodeContextMenuNodeId: string|null = null
    private topologyNodeContextMenuKind: 'node'|'shape' = 'node'
    selectedFilePathKeys = new Set<string>()
    selectedFolderPathKeys = new Set<string>()
    private fileSelectionAnchorKey: string|null = null
    private folderSelectionAnchorKey: string|null = null
    private editorLineSelectionAnchorByEditor = new WeakMap<any, number>()
    private draggingDocId: string|null = null
    private draggingPath: string|null = null
    private draggingIsFolder = false
    expandedFolders = new Set<string>()
    private hiddenTreePathKeys = new Set<string>()
    /** Paths deleted during this session — saveTemp refuses to write here. */
    private deletedTempPaths = new Set<string>()
    private externalFileScopedRoots = new Map<string, Set<string>>()
    private folderTreeModes = new Map<string, FolderTreeMode>()
    private _treeItems: Array<{ node: TreeNode, depth: number }> = []
    private _visibleTreeItems: Array<{ node: TreeNode, depth: number }> = []
    private treeKeyboardActive = false
    private canCloseCheckPromise: Promise<boolean>|null = null
    private confirmedCloseDiscardSignature: string|null = null

    get hasRunTerminal (): boolean {
        return !!this.runTerminalTab
    }

    private formatSelectionActionLabel (single: string, plural: string, fileCount: number, folderCount: number): string {
        const total = fileCount + folderCount
        if (total <= 1) {
            return single
        }
        const parts: string[] = []
        if (fileCount) {
            parts.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`)
        }
        if (folderCount) {
            parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`)
        }
        return `${plural} ${parts.join(', ')}`
    }

    get selectionContextDeleteLabel (): string {
        const selected = this.getSelectedActionTargets(this.fileContextMenuPaths, this.folderContextMenuPaths)
        return this.formatSelectionActionLabel('Delete (disk)', 'Delete', selected.fileTargets.length, selected.folderTargets.length) + (selected.fileTargets.length + selected.folderTargets.length > 1 ? ' (disk)' : '')
    }

    get selectionContextDuplicateLabel (): string {
        const selected = this.getSelectedActionTargets(this.fileContextMenuPaths, this.folderContextMenuPaths)
        return this.formatSelectionActionLabel('Duplicate', 'Duplicate', selected.fileTargets.length, selected.folderTargets.length)
    }

    get selectionContextMoveLabel (): string {
        const selected = this.getSelectedActionTargets(this.fileContextMenuPaths, this.folderContextMenuPaths)
        return this.formatSelectionActionLabel('Move…', 'Move', selected.fileTargets.length, selected.folderTargets.length)
    }

    get folderScopeToggleLabel (): string {
        if (!this.folderContextScopeRoot) {
            return 'Opened files only'
        }
        return this.folderContextScopeMode === 'opened' ? 'Show full folder' : 'Opened files only'
    }

    get canDeleteOnDisk (): boolean {
        const selected = this.getSelectedActionTargets()
        if (selected.fileTargets.length > 0 || selected.folderTargets.length > 0) {
            return true
        }
        return !!this.getActiveDoc()?.path
    }

    get canDuplicateOnDisk (): boolean {
        const selected = this.getSelectedActionTargets()
        if (selected.fileTargets.length > 0 || selected.folderTargets.length > 0) {
            return true
        }
        return !!this.getActiveDoc()?.path
    }

    get canMoveOnDisk (): boolean {
        const selected = this.getSelectedActionTargets()
        if (selected.fileTargets.length > 0 || selected.folderTargets.length > 0) {
            return true
        }
        return !!this.getActiveDoc()?.path
    }

    get isFolderContextProtectedRoot (): boolean {
        return this.isProtectedWorkspaceFolder(this.folderContextMenuPath)
    }

    get canRemoveFolderFromList (): boolean {
        const folderPath = this.folderContextMenuPath
        if (!folderPath || this.isProtectedWorkspaceFolder(folderPath)) {
            return false
        }
        return !!this.folders.find(folder => this.isSameFsPath(folder.path, folderPath))
    }

    get canDeleteFolderContextSelection (): boolean {
        const selected = this.getSelectedActionTargets(this.fileContextMenuPaths, this.folderContextMenuPaths)
        return selected.fileTargets.length > 0 || selected.folderTargets.length > 0
    }

    get activeExternalConflictDoc (): EditorDocument|null {
        const active = this.getActiveDoc()
        if (!active?.externalConflict) {
            return null
        }
        return active
    }

    statusLineCol = ''
    statusLanguage = ''
    statusEOL = ''
    statusIndent = ''
    statusEncoding = 'UTF-8'
    statusWrap = ''

    private monaco?: Monaco
    private monacoPromise?: Promise<Monaco>
    private monacoAmdRequire?: any
    private monacoBase = this.resolveMonacoBase()
    private folderRoot = this.getFolderRoot()
    private primaryEditor: any
    splitEditor: any
    private diffEditor: any
    private diffOriginalModel: any
    private autosaveTimer?: number
    private externalOpenHandler?: (e: Event) => void
    private tempSaveTimers = new Map<string, number>()
    private persistStateTimer?: number
    private persistFoldersTimer?: number
    private treeRefreshTimer?: number
    private treeViewportRaf?: number
    private externalWatchTimer?: number
    private externalWatchBusy = false
    private fileMenuHoverCloseTimer?: number
    private editMenuHoverCloseTimer?: number
    private readonly menuHoverCloseDelayMs = 140
    private treeBuildNonce = 0
    private deletingPathKeys = new Set<string>()
    private deleteInProgress = false
    private focusedEditor: 'primary'|'split' = 'primary'
    private pendingSplitDocId: string|null = null
    private resizingSidebar = false
    private resizeStartX = 0
    private resizeStartWidth = 0
    private mousemoveRafPending = false
    private resizeRafPending = false
    private topologyDragNodeId: string|null = null
    private topologyDragOffsetX = 0
    private topologyDragOffsetY = 0
    private topologyDragChanged = false
    private topologyResizeNodeId: string|null = null
    private topologyNodeResizeStartX = 0
    private topologyNodeResizeStartY = 0
    private topologyNodeResizeStartWidth = 0
    private topologyNodeResizeStartHeight = 0
    private topologyNodeResizeChanged = false
    private topologyDragTextId: string|null = null
    private topologyTextDragOffsetX = 0
    private topologyTextDragOffsetY = 0
    private topologyTextDragChanged = false
    private topologyResizeTextId: string|null = null
    private topologyTextResizeStartX = 0
    private topologyTextResizeStartY = 0
    private topologyTextResizeStartWidth = 0
    private topologyTextResizeStartHeight = 0
    private topologyTextResizeChanged = false
    private topologyDragShapeId: string|null = null
    private topologyShapeDragOffsetX = 0
    private topologyShapeDragOffsetY = 0
    private topologyShapeDragChanged = false
    private topologyResizeShapeId: string|null = null
    private topologyShapeResizeStartX = 0
    private topologyShapeResizeStartY = 0
    private topologyShapeResizeStartWidth = 0
    private topologyShapeResizeStartHeight = 0
    private topologyShapeResizeChanged = false
    private topologyDragFreeLinkId: string|null = null
    private topologyDragFreeLinkHandle: 'start'|'end'|'move'|null = null
    private topologyFreeLinkMoveStartPointerX = 0
    private topologyFreeLinkMoveStartPointerY = 0
    private topologyFreeLinkMoveStartX1 = 0
    private topologyFreeLinkMoveStartY1 = 0
    private topologyFreeLinkMoveStartX2 = 0
    private topologyFreeLinkMoveStartY2 = 0
    private topologyFreeLinkHandleDragChanged = false
    private topologyPanDragActive = false
    private topologyPanDragStartX = 0
    private topologyPanDragStartY = 0
    private topologyPanDragOriginX = 0
    private topologyPanDragOriginY = 0
    private topologyPanDragMoved = false
    private topologyPanClearSelectionOnClick = false
    private topologyPointerSpaceCache: { left: number, top: number, panX: number, panY: number, zoom: number }|null = null
    private topologyRenderRaf?: number
    private topologyLinkRenderItemsCache: TopologyLinkRenderItem[] = []
    private topologyLinkRenderItemsDirty = true
    private topologyMarqueeStartRawX = 0
    private topologyMarqueeStartRawY = 0
    private topologyMarqueeCurrentRawX = 0
    private topologyMarqueeCurrentRawY = 0
    private topologyMarqueeMoved = false
    private topologyMarqueeAppendSelection = false
    private topologyMarqueeSeedNodeIds = new Set<string>()
    private topologyMarqueeSeedLinkIds = new Set<string>()
    private topologyMarqueeSeedShapeIds = new Set<string>()
    private topologyMarqueeSeedTextIds = new Set<string>()
    private topologyInlineEditNodeId: string|null = null
    private topologyInlineEditLinkId: string|null = null
    private topologyInlineEditLinkLabelId: string|null = null
    private topologyInlineEditLinkX: number|null = null
    private topologyInlineEditLinkY: number|null = null
    private topologyInlineEditShapeId: string|null = null
    private topologyInlineEditTextId: string|null = null
    topologyInlineEditValue = ''
    private topologyNodeClipboard: TopologyNodeClipboardData|null = null
    private topologyNodePasteSerial = 0
    private topologyHistoryDocId: string|null = null
    private topologyLastCommittedSerialized = ''
    private topologyUndoStack: string[] = []
    private topologyRedoStack: string[] = []
    private topologyApplyingUndoRedo = false
    private topologyRestorePointsByDoc = new Map<string, TopologyRestorePoint[]>()
    private readonly topologyUndoLimit = 120
    private readonly topologyRestorePointLimit = 40
    private readonly topologyRestorePointMinIntervalMs = 8000
    private topologyWritingDoc = false
    private readonly treeNodeBudget = 4000
    private readonly treeVirtualizationThreshold = 220
    private readonly treeVirtualRowHeightPx = 34
    private readonly treeVirtualOverscanRows = 12
    private readonly quickOpenBudget = 3000
    private readonly externalWatchIntervalMs = 1800
    private readonly skippedFolders = new Set(['.git', 'node_modules', '.svn', '.hg', '.idea', '.vscode', 'dist', 'build'])
    private readonly studioTitle = 'Tlink Studio'
    private readonly simpleDiskMode = true
    private readonly topologyNodeWidthPx = 176
    private readonly topologyNodeHeightPx = 72
    private readonly topologyStickyDefaultWidthPx = 350
    private readonly topologyStickyDefaultHeightPx = 150
    private readonly topologyStickyCollapsedHeightPx = 34
    private readonly editorStateFileName = 'tlink-studio-editor-state.json'
    private editorStateFilePathCache: string|null = null
    private editorStateValues: Record<string, string> = {}
    private editorStateLoaded = false
    private editorStatePersistTimer?: number

    private resolveStudioDir (preferredName: string, legacyName?: string): string {
        const home = process.env.TLINK_CONFIG_DIR || process.env.HOME || os.homedir()
        const baseDir = path.join(home || os.tmpdir(), '.tlink')
        const preferredDir = path.join(baseDir, preferredName)
        const legacyDir = legacyName ? path.join(baseDir, legacyName) : null
        if (fsSync.existsSync(preferredDir)) {
            return preferredDir
        }
        try {
            if (legacyDir && fsSync.existsSync(legacyDir)) {
                fsSync.renameSync(legacyDir, preferredDir)
                return preferredDir
            }
            fsSync.mkdirSync(preferredDir, { recursive: true })
            return preferredDir
        } catch {
            if (legacyDir && fsSync.existsSync(legacyDir)) {
                return legacyDir
            }
            return os.tmpdir()
        }
    }

    private getFolderRoot (): string {
        return this.resolveStudioDir('tlink-studio', 'code-editor')
    }

    private getFolderDisplayName (folderPath: string): string {
        if (this.isSameFsPath(folderPath, this.folderRoot)) {
            return this.studioTitle
        }
        return path.basename(folderPath) || folderPath || 'Folder'
    }

    private ensureWorkspaceRootExists (): string {
        const localRoot = path.resolve(this.folderRoot)
        try {
            fsSync.mkdirSync(localRoot, { recursive: true })
        } catch {
            // best effort
        }
        return localRoot
    }

    private ensureWorkspaceRootAttached (): string {
        const localRoot = this.ensureWorkspaceRootExists()
        const existing = this.folders.find(folder => this.isSameFsPath(folder.path, localRoot))
        if (existing) {
            existing.path = localRoot
            existing.name = this.getFolderDisplayName(localRoot)
            return localRoot
        }
        this.folders.unshift({ path: localRoot, name: this.getFolderDisplayName(localRoot) })
        this.persistFolders()
        return localRoot
    }

    private getEditorStateFilePath (): string {
        if (this.editorStateFilePathCache) {
            return this.editorStateFilePathCache
        }
        const configPath = this.platform.getConfigPath?.() ?? null
        const baseDir = configPath ? path.dirname(configPath) : path.dirname(path.resolve(this.folderRoot))
        this.editorStateFilePathCache = path.join(baseDir, this.editorStateFileName)
        return this.editorStateFilePathCache
    }

    private ensureEditorStateLoaded (): void {
        if (this.editorStateLoaded) {
            return
        }
        this.editorStateLoaded = true
        const filePath = this.getEditorStateFilePath()
        try {
            if (fsSync.existsSync(filePath)) {
                const raw = fsSync.readFileSync(filePath, 'utf8')
                const parsed = JSON.parse(raw) as EditorStateFilePayload|Record<string, unknown>
                const values = (parsed as EditorStateFilePayload)?.values
                const source = values && typeof values === 'object' && !Array.isArray(values)
                    ? values
                    : parsed
                if (source && typeof source === 'object' && !Array.isArray(source)) {
                    const next: Record<string, string> = {}
                    for (const [key, value] of Object.entries(source)) {
                        if (typeof key !== 'string' || !key.startsWith('codeEditor.')) {
                            continue
                        }
                        if (typeof value !== 'string') {
                            continue
                        }
                        next[key] = value
                    }
                    this.editorStateValues = next
                }
            }
        } catch {
            this.editorStateValues = {}
        }

        // One-time migration from localStorage for older builds.
        if (!Object.keys(this.editorStateValues).length && typeof localStorage !== 'undefined') {
            let migrated = false
            const next: Record<string, string> = {}
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i)
                    if (!key || !key.startsWith('codeEditor.')) {
                        continue
                    }
                    const value = localStorage.getItem(key)
                    if (value === null) {
                        continue
                    }
                    next[key] = value
                    migrated = true
                }
            } catch {
                // Ignore localStorage migration errors in hardened runtimes.
            }
            this.editorStateValues = next
            if (migrated) {
                this.queueEditorStatePersist()
            }
        }
    }

    private queueEditorStatePersist (): void {
        if (this.editorStatePersistTimer) {
            return
        }
        this.editorStatePersistTimer = window.setTimeout(() => {
            this.editorStatePersistTimer = undefined
            this.flushEditorStateToDisk()
        }, 0)
    }

    private flushEditorStateToDisk (): void {
        this.ensureEditorStateLoaded()
        try {
            const filePath = this.getEditorStateFilePath()
            fsSync.mkdirSync(path.dirname(filePath), { recursive: true })
            const payload: EditorStateFilePayload = {
                version: 1,
                updatedAt: new Date().toISOString(),
                values: this.editorStateValues,
            }
            fsSync.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
        } catch (error) {
            console.warn('[code-editor] Failed to persist state file:', error)
        }
    }

    private getStateItem (key: string): string|null {
        this.ensureEditorStateLoaded()
        return Object.prototype.hasOwnProperty.call(this.editorStateValues, key) ? this.editorStateValues[key] : null
    }

    private setStateItem (key: string, value: string): void {
        this.ensureEditorStateLoaded()
        if (this.editorStateValues[key] === value) {
            return
        }
        this.editorStateValues[key] = value
        this.queueEditorStatePersist()
    }

    private loadFoldersFromState (): void {
        const localRoot = this.ensureWorkspaceRootExists()
        let paths: string[] = []
        const stored = this.getStateItem('codeEditor.folders')
        if (stored) {
            try {
                paths = JSON.parse(stored) ?? []
            } catch {
                paths = []
            }
        }
        if (!paths.includes(localRoot)) {
            paths.unshift(localRoot)
        }
        const existing = paths
            .map(p => p ? path.resolve(p) : '')
            .filter(p => p && fsSync.existsSync(p) && fsSync.statSync(p).isDirectory())
            .filter(p => this.isSameFsPath(p, localRoot) || !this.isTreePathEqualOrDescendant(p, localRoot))
        const unique: string[] = []
        for (const p of existing) {
            if (!unique.some(existingPath => this.isSameFsPath(existingPath, p))) {
                unique.push(path.resolve(p))
            }
        }
        if (!unique.some(p => this.isSameFsPath(p, localRoot))) {
            unique.unshift(localRoot)
        }
        this.folders = unique.map(p => ({ path: p, name: this.getFolderDisplayName(p) }))
        this.loadScopedExternalFilesFromState(unique)
        this.loadFolderTreeModesFromState(unique)
        const savedSelected = this.getStateItem('codeEditor.selectedFolder')
        this.selectedFolderPath = savedSelected && unique.includes(savedSelected) ? savedSelected : null
        const storedExpanded = this.getStateItem('codeEditor.expandedFolders')
        if (storedExpanded) {
            try {
                this.expandedFolders = new Set(JSON.parse(storedExpanded) ?? [])
            } catch {
                this.expandedFolders = new Set()
            }
        }
        const storedHidden = this.getStateItem('codeEditor.hiddenTreePaths')
        if (!this.simpleDiskMode && storedHidden) {
            try {
                const parsed = JSON.parse(storedHidden)
                this.hiddenTreePathKeys = new Set((Array.isArray(parsed) ? parsed : []).filter(x => typeof x === 'string'))
            } catch {
                this.hiddenTreePathKeys = new Set()
            }
        }
        if (this.simpleDiskMode) {
            this.hiddenTreePathKeys = new Set()
            this.setStateItem('codeEditor.hiddenTreePaths', '[]')
        }
        if (this.simpleDiskMode) {
            this.expandedFolders.add(localRoot)
        }
        if (!this.expandedFolders.size) {
            for (const f of this.folders) {
                this.expandedFolders.add(f.path)
            }
        }
        // Don't call updateTreeItems here - it will be called in ngAfterViewInit
        // to avoid ExpressionChangedAfterItHasBeenCheckedError
    }

    private persistFolders (): void {
        // Coalesce rapid calls (e.g. multiple hideTreePath / closeDocument
        // calls in quick succession) to avoid redundant state-file writes
        // while keeping in-memory state always current.
        if (this.persistFoldersTimer) {
            return
        }
        this.persistFoldersTimer = window.setTimeout(() => {
            this.persistFoldersTimer = undefined
            this.flushPersistFolders()
        }, 0)
    }

    private flushPersistFolders (): void {
        this.setStateItem('codeEditor.folders', JSON.stringify(this.folders.map(f => f.path)))
        this.setStateItem('codeEditor.selectedFolder', this.selectedFolderPath ?? '')
        this.setStateItem('codeEditor.expandedFolders', JSON.stringify(Array.from(this.expandedFolders)))
        this.setStateItem(
            'codeEditor.hiddenTreePaths',
            this.simpleDiskMode ? '[]' : JSON.stringify(Array.from(this.hiddenTreePathKeys)),
        )
        this.persistFolderTreeModes()
        this.persistScopedExternalFiles()
    }

    selectFolder (folderPath: string|null, syncTreeSelection = true): void {
        this.selectedFolderPath = folderPath
        if (syncTreeSelection) {
            this.setFolderSelection(folderPath ? [folderPath] : [])
            this.setFileSelection([])
        }
        this.persistFolders()
    }

    private resolveDocFolder (doc: EditorDocument): string|null {
        return doc.folderPath ?? this.getFolderForPath(doc.path)
    }

    getDocById (docId: string): EditorDocument|null {
        return this.documents.find(d => d.id === docId) ?? null
    }

    private isProtectedWorkspaceFolder (folderPath: string|null|undefined): boolean {
        if (!folderPath) {
            return false
        }
        return this.isSameFsPath(folderPath, this.folderRoot)
    }

    isTreeNodeClosable (node: TreeNode): boolean {
        if (node.isFolder) {
            return !!node.path && !this.isProtectedWorkspaceFolder(node.path)
        }
        return !!node.docId || !!node.path
    }

    getTreeCloseTitle (node: TreeNode): string {
        if (node.isFolder) {
            if (this.isProtectedWorkspaceFolder(node.path)) {
                return 'Protected workspace folder'
            }
            return 'Delete folder from disk'
        }
        if (node.path) {
            return 'Delete file from disk'
        }
        return 'Close file'
    }

    async closeTreeNode (node: TreeNode): Promise<void> {
        if (node.isFolder) {
            const folderPath = node.path
            if (!folderPath) {
                return
            }
            if (this.isProtectedWorkspaceFolder(folderPath)) {
                return
            }
            await this.deleteSelectionOnDisk([], [folderPath])
            return
        }

        if (node.path) {
            await this.deleteSelectionOnDisk([node.path], [])
            return
        }
        if (node.docId) {
            await this.closeDocument(node.docId)
        }
    }

    private getFolderForPath (filePath: string|null): string|null {
        if (!filePath) {
            return null
        }
        const normalized = path.resolve(filePath)
        let bestMatch: string|null = null
        let bestLength = -1
        for (const folder of this.folders) {
            const folderResolved = path.resolve(folder.path)
            if (normalized === folderResolved || normalized.startsWith(folderResolved + path.sep)) {
                if (folderResolved.length > bestLength) {
                    bestMatch = folder.path
                    bestLength = folderResolved.length
                }
            }
        }
        return bestMatch
    }

    private getWorkspaceRootForPath (targetPath: string|null|undefined): string|null {
        if (!targetPath) {
            return null
        }
        return this.getFolderForPath(targetPath)
    }

    private getFolderTreeMode (rootPath: string|null|undefined): FolderTreeMode {
        const rootKey = this.getFsPathKey(rootPath)
        if (!rootKey) {
            return 'full'
        }
        return this.folderTreeModes.get(rootKey) === 'opened' ? 'opened' : 'full'
    }

    private setFolderTreeMode (rootPath: string|null|undefined, mode: FolderTreeMode): void {
        const rootKey = this.getFsPathKey(rootPath)
        if (!rootKey) {
            return
        }
        if (mode === 'opened') {
            this.folderTreeModes.set(rootKey, 'opened')
        } else {
            this.folderTreeModes.delete(rootKey)
        }
    }

    private isSameStringSet (left: Set<string>, right: Set<string>): boolean {
        if (left.size !== right.size) {
            return false
        }
        for (const value of left) {
            if (!right.has(value)) {
                return false
            }
        }
        return true
    }

    private getOpenFileKeysForRoot (rootPath: string): Set<string> {
        const rootKey = this.getFsPathKey(rootPath)
        const keys = new Set<string>()
        if (!rootKey) {
            return keys
        }
        for (const doc of this.documents) {
            const docPath = doc.path ?? doc.tempPath ?? null
            const docKey = this.getFsPathKey(docPath)
            if (!docKey) {
                continue
            }
            if (docKey === rootKey || docKey.startsWith(rootKey + path.sep)) {
                keys.add(docKey)
            }
        }
        return keys
    }

    private syncOpenedFileScopeForRoot (rootPath: string): boolean {
        const rootKey = this.getFsPathKey(rootPath)
        if (!rootKey) {
            return false
        }
        if (this.getFolderTreeMode(rootPath) !== 'opened') {
            if (this.externalFileScopedRoots.has(rootKey)) {
                this.externalFileScopedRoots.delete(rootKey)
                return true
            }
            return false
        }

        const next = this.getOpenFileKeysForRoot(rootPath)
        const previous = this.externalFileScopedRoots.get(rootKey) ?? new Set<string>()
        if (this.isSameStringSet(previous, next)) {
            return false
        }
        this.externalFileScopedRoots.set(rootKey, next)
        for (const fileKey of next) {
            this.expandPathWithinRoot(rootPath, fileKey)
        }
        return true
    }

    private syncOpenedFileScopes (): boolean {
        let changed = false
        const openedRootKeys = new Set<string>()
        for (const folder of this.folders) {
            const rootKey = this.getFsPathKey(folder.path)
            if (!rootKey) {
                continue
            }
            if (this.getFolderTreeMode(folder.path) === 'opened') {
                openedRootKeys.add(rootKey)
            }
            if (this.syncOpenedFileScopeForRoot(folder.path)) {
                changed = true
            }
        }
        for (const rootKey of Array.from(this.externalFileScopedRoots.keys())) {
            if (!openedRootKeys.has(rootKey)) {
                this.externalFileScopedRoots.delete(rootKey)
                changed = true
            }
        }
        return changed
    }

    private setRootModeToOpenedFiles (rootPath: string, includePath?: string|null): void {
        const rootKey = this.getFsPathKey(rootPath)
        if (!rootKey) {
            return
        }
        this.setFolderTreeMode(rootPath, 'opened')
        const scoped = this.getOpenFileKeysForRoot(rootPath)
        const activePath = this.getActiveDoc()?.path ?? null
        const activeKey = this.getFsPathKey(activePath)
        if (activeKey && (activeKey === rootKey || activeKey.startsWith(rootKey + path.sep))) {
            scoped.add(activeKey)
        }
        for (const filePath of this.getSelectedFilePathsFromTree()) {
            const selectedKey = this.getFsPathKey(filePath)
            if (selectedKey && (selectedKey === rootKey || selectedKey.startsWith(rootKey + path.sep))) {
                scoped.add(selectedKey)
            }
        }
        if (includePath) {
            const fileKey = this.getFsPathKey(includePath)
            if (fileKey && (fileKey === rootKey || fileKey.startsWith(rootKey + path.sep))) {
                scoped.add(fileKey)
                this.expandPathWithinRoot(rootPath, includePath)
            }
        }
        this.externalFileScopedRoots.set(rootKey, scoped)
    }

    private setRootModeToFullFolder (rootPath: string): void {
        this.setFolderTreeMode(rootPath, 'full')
        this.clearScopedExternalFiles(rootPath)
    }

    private clearScopedExternalFiles (rootPath: string): void {
        const rootKey = this.getFsPathKey(rootPath)
        if (!rootKey) {
            return
        }
        this.externalFileScopedRoots.delete(rootKey)
    }

    private getScopedExternalFiles (rootPath: string): Set<string>|null {
        const rootKey = this.getFsPathKey(rootPath)
        if (!rootKey) {
            return null
        }
        return this.externalFileScopedRoots.get(rootKey) ?? null
    }

    private loadFolderTreeModesFromState (existingFolderPaths: string[]): void {
        this.folderTreeModes = new Map<string, FolderTreeMode>()
        const existingRootKeys = new Set<string>()
        for (const folderPath of existingFolderPaths) {
            const rootKey = this.getFsPathKey(folderPath)
            if (rootKey) {
                existingRootKeys.add(rootKey)
            }
        }
        const stored = this.getStateItem('codeEditor.folderTreeModes')
        if (stored) {
            try {
                const parsed = JSON.parse(stored) as Record<string, unknown>
                for (const [rawRoot, rawMode] of Object.entries(parsed ?? {})) {
                    if (rawMode !== 'opened') {
                        continue
                    }
                    const rootKey = this.getFsPathKey(rawRoot) ?? rawRoot
                    if (!rootKey || !existingRootKeys.has(rootKey)) {
                        continue
                    }
                    this.folderTreeModes.set(rootKey, 'opened')
                }
            } catch {
                this.folderTreeModes = new Map<string, FolderTreeMode>()
            }
        }
        // Migration for older builds that persisted scoped roots without an explicit mode map.
        for (const rootKey of this.externalFileScopedRoots.keys()) {
            if (!existingRootKeys.has(rootKey)) {
                continue
            }
            this.folderTreeModes.set(rootKey, 'opened')
        }
    }

    private persistFolderTreeModes (): void {
        const existingRootKeys = new Set<string>()
        for (const folder of this.folders) {
            const rootKey = this.getFsPathKey(folder.path)
            if (rootKey) {
                existingRootKeys.add(rootKey)
            }
        }
        const payload: Record<string, FolderTreeMode> = {}
        for (const [rootKey, mode] of this.folderTreeModes) {
            if (mode !== 'opened' || !existingRootKeys.has(rootKey)) {
                continue
            }
            payload[rootKey] = mode
        }
        this.setStateItem('codeEditor.folderTreeModes', JSON.stringify(payload))
    }

    private loadScopedExternalFilesFromState (existingFolderPaths: string[]): void {
        this.externalFileScopedRoots = new Map<string, Set<string>>()
        const stored = this.getStateItem('codeEditor.externalScopedFiles')
        if (!stored) {
            return
        }
        let parsed: unknown
        try {
            parsed = JSON.parse(stored)
        } catch {
            return
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return
        }
        const existingRootKeys = new Set<string>()
        for (const folderPath of existingFolderPaths) {
            const key = this.getFsPathKey(folderPath)
            if (key) {
                existingRootKeys.add(key)
            }
        }
        for (const [rawRoot, rawFiles] of Object.entries(parsed as Record<string, unknown>)) {
            const rootKey = this.getFsPathKey(rawRoot) ?? rawRoot
            if (!rootKey || !existingRootKeys.has(rootKey)) {
                continue
            }
            const scopedFiles = new Set<string>()
            const fileList = Array.isArray(rawFiles) ? rawFiles : []
            for (const rawFile of fileList) {
                if (typeof rawFile !== 'string') {
                    continue
                }
                const fileKey = this.getFsPathKey(rawFile) ?? rawFile
                if (!fileKey) {
                    continue
                }
                if (fileKey === rootKey || fileKey.startsWith(rootKey + path.sep)) {
                    scopedFiles.add(fileKey)
                }
            }
            if (scopedFiles.size) {
                this.externalFileScopedRoots.set(rootKey, scopedFiles)
            }
        }
    }

    private persistScopedExternalFiles (): void {
        const payload: Record<string, string[]> = {}
        const existingRootKeys = new Set<string>()
        for (const folder of this.folders) {
            const key = this.getFsPathKey(folder.path)
            if (key) {
                existingRootKeys.add(key)
            }
        }
        for (const [rootKey, scopedFiles] of this.externalFileScopedRoots) {
            if (!rootKey || !existingRootKeys.has(rootKey)) {
                continue
            }
            const sanitized = Array.from(scopedFiles).filter(fileKey => !!fileKey && (fileKey === rootKey || fileKey.startsWith(rootKey + path.sep)))
            if (!sanitized.length) {
                continue
            }
            payload[rootKey] = Array.from(new Set(sanitized))
        }
        this.setStateItem('codeEditor.externalScopedFiles', JSON.stringify(payload))
    }

    private hydrateScopedRootsFromOpenDocuments (): boolean {
        let changed = false
        for (const folder of this.folders) {
            const rootKey = this.getFsPathKey(folder.path)
            if (!rootKey) {
                continue
            }
            if (this.getFolderTreeMode(folder.path) !== 'opened') {
                continue
            }
            const scopedByKey = new Set<string>()
            for (const doc of this.documents) {
                const docPath = doc.path ?? doc.tempPath ?? null
                const docKey = this.getFsPathKey(docPath)
                if (!docKey) {
                    continue
                }
                if (docKey === rootKey || docKey.startsWith(rootKey + path.sep)) {
                    scopedByKey.add(docKey)
                }
            }
            const previous = this.externalFileScopedRoots.get(rootKey) ?? new Set<string>()
            if (this.isSameStringSet(previous, scopedByKey)) {
                continue
            }
            this.externalFileScopedRoots.set(rootKey, scopedByKey)
            for (const resolvedPath of scopedByKey) {
                this.expandPathWithinRoot(folder.path, resolvedPath)
            }
            changed = true
        }
        return changed
    }

    private shouldIncludeScopedTreeEntry (scopedFiles: Set<string>|null, mode: FolderTreeMode, entryPath: string, isDirectory: boolean): boolean {
        if (mode !== 'opened') {
            return true
        }
        if (!scopedFiles || !scopedFiles.size) {
            return false
        }
        const entryKey = this.getFsPathKey(entryPath)
        if (!entryKey) {
            return false
        }
        if (!isDirectory) {
            return scopedFiles.has(entryKey)
        }
        for (const scopedFileKey of scopedFiles) {
            if (scopedFileKey === entryKey || scopedFileKey.startsWith(entryKey + path.sep)) {
                return true
            }
        }
        return false
    }

    private expandPathWithinRoot (rootPath: string, targetPath: string): void {
        const root = path.resolve(rootPath)
        let cursor = path.resolve(path.dirname(targetPath))
        while (this.isTreePathEqualOrDescendant(cursor, root)) {
            this.expandedFolders.add(cursor)
            if (this.isSameFsPath(cursor, root)) {
                break
            }
            const parent = path.dirname(cursor)
            if (parent === cursor) {
                break
            }
            cursor = parent
        }
        this.expandedFolders.add(root)
    }

    private ensurePathVisibleInTree (targetPath: string, selectFolder = false, scopeToOpenedFileOnly = false): void {
        const resolved = path.resolve(targetPath)
        const existingRoot = this.getFolderForPath(resolved)
        if (existingRoot) {
            if (scopeToOpenedFileOnly) {
                const alreadyOpenedOnly = this.getFolderTreeMode(existingRoot) === 'opened'
                const canAutoScope = alreadyOpenedOnly || !this.isSameFsPath(existingRoot, this.folderRoot)
                if (canAutoScope) {
                    this.setRootModeToOpenedFiles(existingRoot, resolved)
                    this.expandPathWithinRoot(existingRoot, resolved)
                }
            }
            if (selectFolder) {
                this.selectFolder(existingRoot)
            }
            return
        }
        const parentDir = path.dirname(resolved)
        if (!parentDir || parentDir === resolved) {
            return
        }
        this.attachFolderToTree(parentDir, selectFolder, scopeToOpenedFileOnly ? resolved : null)
    }

    private normalizeFsPath (filePath: string|null): string|null {
        if (!filePath) {
            return null
        }
        let normalized = path.resolve(filePath)
        try {
            if ((fsSync.realpathSync as any).native) {
                normalized = (fsSync.realpathSync as any).native(normalized)
            } else {
                normalized = fsSync.realpathSync(normalized)
            }
        } catch {
            // Use the resolved path when realpath is unavailable.
        }
        if (process.platform === 'win32') {
            normalized = normalized.toLowerCase()
        }
        return normalized
    }

    private isSameFsPath (a: string|null|undefined, b: string|null|undefined): boolean {
        const left = this.normalizeFsPath(a ?? null)
        const right = this.normalizeFsPath(b ?? null)
        return !!left && !!right && left === right
    }

    private getFsPathKey (filePath: string|null|undefined): string|null {
        const normalized = this.normalizeFsPath(filePath ?? null)
        if (normalized) {
            return normalized
        }
        if (!filePath) {
            return null
        }
        let fallback = path.resolve(filePath)
        if (process.platform === 'win32') {
            fallback = fallback.toLowerCase()
        }
        return fallback
    }

    private toTreePathKey (filePath: string|null|undefined): string|null {
        if (!filePath) {
            return null
        }
        let resolved = path.resolve(filePath)
        if (process.platform === 'win32') {
            resolved = resolved.toLowerCase()
        }
        return resolved
    }

    private isPathHiddenInTree (filePath: string|null|undefined): boolean {
        if (this.simpleDiskMode) {
            return false
        }
        const key = this.toTreePathKey(filePath)
        if (!key) {
            return false
        }
        const hiddenKeys = new Set(this.hiddenTreePathKeys)
        const storedHidden = this.getStateItem('codeEditor.hiddenTreePaths')
        if (storedHidden) {
            try {
                const parsed = JSON.parse(storedHidden)
                if (Array.isArray(parsed)) {
                    for (const candidate of parsed) {
                        if (typeof candidate === 'string' && candidate) {
                            const candidateKey = this.toTreePathKey(candidate)
                            if (candidateKey) {
                                hiddenKeys.add(candidateKey)
                            }
                        }
                    }
                }
            } catch {
                // ignore malformed persisted hidden-path state
            }
        }
        if (!hiddenKeys.size) {
            return false
        }
        for (const hiddenKey of hiddenKeys) {
            if (key === hiddenKey || key.startsWith(hiddenKey + path.sep)) {
                return true
            }
        }
        return false
    }

    private isTreePathEqualOrDescendant (candidatePath: string|null|undefined, ancestorPath: string|null|undefined): boolean {
        const candidate = this.toTreePathKey(candidatePath)
        const ancestor = this.toTreePathKey(ancestorPath)
        return !!candidate && !!ancestor && (candidate === ancestor || candidate.startsWith(ancestor + path.sep))
    }

    private hideTreePath (targetPath: string, includeDescendants = false): void {
        const targetKey = this.toTreePathKey(targetPath)
        if (!targetKey) {
            return
        }
        const next = new Set(this.hiddenTreePathKeys)
        next.add(targetKey)
        if (includeDescendants) {
            for (const key of Array.from(next)) {
                if (key !== targetKey && key.startsWith(targetKey + path.sep)) {
                    next.delete(key)
                }
            }
        }
        this.hiddenTreePathKeys = next
        this.persistFolders()
    }

    private revealTreePath (targetPath: string, includeDescendants = false): void {
        const targetKey = this.toTreePathKey(targetPath)
        if (!targetKey || !this.hiddenTreePathKeys.size) {
            return
        }
        let changed = false
        const next = new Set<string>()
        for (const hiddenKey of this.hiddenTreePathKeys) {
            const isSelf = hiddenKey === targetKey
            const isAncestor = targetKey.startsWith(hiddenKey + path.sep)
            const isDescendant = hiddenKey.startsWith(targetKey + path.sep)
            if (isSelf || isAncestor || (includeDescendants && isDescendant)) {
                changed = true
                continue
            }
            next.add(hiddenKey)
        }
        if (!changed) {
            return
        }
        this.hiddenTreePathKeys = next
        this.persistFolders()
    }

    isTreeFileSelected (filePath: string|null|undefined): boolean {
        const key = this.getFsPathKey(filePath)
        return !!key && this.selectedFilePathKeys.has(key)
    }

    isTreeFolderSelected (folderPath: string|null|undefined): boolean {
        const key = this.getFsPathKey(folderPath)
        return !!key && this.selectedFolderPathKeys.has(key)
    }

    private getVisibleTreeFilePaths (): string[] {
        const result: string[] = []
        for (const item of this._treeItems) {
            if (item.node.isFolder || !item.node.path) {
                continue
            }
            result.push(item.node.path)
        }
        return result
    }

    private getVisibleTreeFolderPaths (): string[] {
        const result: string[] = []
        for (const item of this._treeItems) {
            if (!item.node.isFolder || !item.node.path) {
                continue
            }
            result.push(item.node.path)
        }
        return result
    }

    private getSelectedFilePathsFromTree (): string[] {
        const result: string[] = []
        for (const filePath of this.getVisibleTreeFilePaths()) {
            if (this.isTreeFileSelected(filePath)) {
                result.push(filePath)
            }
        }
        return result
    }

    private getSelectedFolderPathsFromTree (): string[] {
        const result: string[] = []
        for (const folderPath of this.getVisibleTreeFolderPaths()) {
            if (this.isTreeFolderSelected(folderPath)) {
                result.push(folderPath)
            }
        }
        return result
    }

    private setFileSelection (filePaths: string[]): void {
        const next = new Set<string>()
        let lastKey: string|null = null
        for (const filePath of filePaths) {
            const key = this.getFsPathKey(filePath)
            if (!key) {
                continue
            }
            next.add(key)
            lastKey = key
        }
        this.selectedFilePathKeys = next
        this.fileSelectionAnchorKey = lastKey
        this.cdr.markForCheck()
    }

    private toggleFileSelection (filePath: string): void {
        const key = this.getFsPathKey(filePath)
        if (!key) {
            return
        }
        const next = new Set(this.selectedFilePathKeys)
        if (next.has(key)) {
            next.delete(key)
        } else {
            next.add(key)
        }
        this.selectedFilePathKeys = next
        this.fileSelectionAnchorKey = key
        this.cdr.markForCheck()
    }

    private extendFileSelection (filePath: string): void {
        const targetKey = this.getFsPathKey(filePath)
        if (!targetKey) {
            return
        }
        const visible = this.getVisibleTreeFilePaths()
        if (!visible.length) {
            return
        }
        const targetIndex = visible.findIndex(p => this.isSameFsPath(p, filePath))
        if (targetIndex < 0) {
            this.setFileSelection([filePath])
            return
        }
        let anchorIndex = -1
        if (this.fileSelectionAnchorKey) {
            anchorIndex = visible.findIndex(p => this.getFsPathKey(p) === this.fileSelectionAnchorKey)
        }
        if (anchorIndex < 0) {
            anchorIndex = targetIndex
        }
        const start = Math.min(anchorIndex, targetIndex)
        const end = Math.max(anchorIndex, targetIndex)
        const next = new Set<string>()
        for (const p of visible.slice(start, end + 1)) {
            const key = this.getFsPathKey(p)
            if (key) {
                next.add(key)
            }
        }
        this.selectedFilePathKeys = next
        if (!this.fileSelectionAnchorKey) {
            this.fileSelectionAnchorKey = targetKey
        }
        this.cdr.markForCheck()
    }

    private setFolderSelection (folderPaths: string[]): void {
        const next = new Set<string>()
        let lastKey: string|null = null
        for (const folderPath of folderPaths) {
            const key = this.getFsPathKey(folderPath)
            if (!key) {
                continue
            }
            next.add(key)
            lastKey = key
        }
        this.selectedFolderPathKeys = next
        this.folderSelectionAnchorKey = lastKey
        this.cdr.markForCheck()
    }

    private clearFolderSelectionOnly (): void {
        if (!this.selectedFolderPath && !this.selectedFolderPathKeys.size) {
            return
        }
        this.selectedFolderPath = null
        this.setFolderSelection([])
        this.persistFolders()
    }

    private toggleFolderSelection (folderPath: string): void {
        const key = this.getFsPathKey(folderPath)
        if (!key) {
            return
        }
        const next = new Set(this.selectedFolderPathKeys)
        if (next.has(key)) {
            next.delete(key)
        } else {
            next.add(key)
        }
        this.selectedFolderPathKeys = next
        this.folderSelectionAnchorKey = key
        this.cdr.markForCheck()
    }

    private remapFileSelectionPath (
        oldPath: string|null|undefined,
        newPath: string|null|undefined,
        oldKeyOverride: string|null = null,
    ): void {
        const oldKey = oldKeyOverride || this.getFsPathKey(oldPath)
        const newKey = this.getFsPathKey(newPath)
        if (!oldKey || !newKey || oldKey === newKey) {
            return
        }
        let changed = false
        if (this.selectedFilePathKeys.has(oldKey)) {
            const next = new Set(this.selectedFilePathKeys)
            next.delete(oldKey)
            next.add(newKey)
            this.selectedFilePathKeys = next
            changed = true
        }
        if (this.fileSelectionAnchorKey === oldKey) {
            this.fileSelectionAnchorKey = newKey
            changed = true
        }
        if (changed) {
            this.cdr.markForCheck()
        }
    }

    private extendFolderSelection (folderPath: string): void {
        const targetKey = this.getFsPathKey(folderPath)
        if (!targetKey) {
            return
        }
        const visible = this.getVisibleTreeFolderPaths()
        if (!visible.length) {
            return
        }
        const targetIndex = visible.findIndex(p => this.isSameFsPath(p, folderPath))
        if (targetIndex < 0) {
            this.setFolderSelection([folderPath])
            return
        }
        let anchorIndex = -1
        if (this.folderSelectionAnchorKey) {
            anchorIndex = visible.findIndex(p => this.getFsPathKey(p) === this.folderSelectionAnchorKey)
        }
        if (anchorIndex < 0) {
            anchorIndex = targetIndex
        }
        const start = Math.min(anchorIndex, targetIndex)
        const end = Math.max(anchorIndex, targetIndex)
        const next = new Set<string>()
        for (const p of visible.slice(start, end + 1)) {
            const key = this.getFsPathKey(p)
            if (key) {
                next.add(key)
            }
        }
        this.selectedFolderPathKeys = next
        if (!this.folderSelectionAnchorKey) {
            this.folderSelectionAnchorKey = targetKey
        }
        this.cdr.markForCheck()
    }

    private pruneFileSelectionToVisibleTree (): void {
        const allowedKeys = new Set<string>()
        for (const filePath of this.getVisibleTreeFilePaths()) {
            const key = this.getFsPathKey(filePath)
            if (key) {
                allowedKeys.add(key)
            }
        }
        if (!allowedKeys.size) {
            this.selectedFilePathKeys = new Set()
            this.fileSelectionAnchorKey = null
            return
        }
        const next = new Set<string>()
        for (const key of this.selectedFilePathKeys) {
            if (allowedKeys.has(key)) {
                next.add(key)
            }
        }
        this.selectedFilePathKeys = next
        if (this.fileSelectionAnchorKey && !allowedKeys.has(this.fileSelectionAnchorKey)) {
            this.fileSelectionAnchorKey = null
        }

        const allowedFolderKeys = new Set<string>()
        for (const folderPath of this.getVisibleTreeFolderPaths()) {
            const key = this.getFsPathKey(folderPath)
            if (key) {
                allowedFolderKeys.add(key)
            }
        }
        if (!allowedFolderKeys.size) {
            this.selectedFolderPathKeys = new Set()
            this.folderSelectionAnchorKey = null
            return
        }
        const nextFolders = new Set<string>()
        for (const key of this.selectedFolderPathKeys) {
            if (allowedFolderKeys.has(key)) {
                nextFolders.add(key)
            }
        }
        this.selectedFolderPathKeys = nextFolders
        if (this.folderSelectionAnchorKey && !allowedFolderKeys.has(this.folderSelectionAnchorKey)) {
            this.folderSelectionAnchorKey = null
        }
    }

    private selectFilesForContextMenu (filePath: string): void {
        if (!this.isTreeFileSelected(filePath)) {
            this.setFileSelection([filePath])
            this.selectedFolderPathKeys = new Set()
            this.folderSelectionAnchorKey = null
        }
        const selectedPaths = this.getSelectedFilePathsFromTree()
        if (!selectedPaths.length) {
            this.fileContextMenuPaths = [filePath]
        } else {
            this.fileContextMenuPaths = selectedPaths
        }
        this.folderContextMenuPaths = this.getSelectedFolderPathsFromTree()
    }

    private selectFoldersForContextMenu (folderPath: string): void {
        if (!folderPath) {
            return
        }
        if (!this.isTreeFolderSelected(folderPath)) {
            this.setFolderSelection([folderPath])
            this.selectedFilePathKeys = new Set()
            this.fileSelectionAnchorKey = null
        }
        const selectedPaths = this.getSelectedFolderPathsFromTree()
        if (!selectedPaths.length) {
            this.folderContextMenuPaths = [folderPath]
        } else {
            this.folderContextMenuPaths = selectedPaths
        }
        this.fileContextMenuPaths = this.getSelectedFilePathsFromTree()
    }

    private getNormalizedFolderTargets (folderPaths: string[]): string[] {
        const uniqueByKey = new Map<string, string>()
        for (const folderPath of folderPaths) {
            const key = this.getFsPathKey(folderPath)
            if (!key || uniqueByKey.has(key)) {
                continue
            }
            uniqueByKey.set(key, folderPath)
        }
        const existing = Array.from(uniqueByKey.values()).filter(folderPath => {
            try {
                return (
                    fsSync.existsSync(folderPath) &&
                    fsSync.statSync(folderPath).isDirectory() &&
                    !this.isProtectedWorkspaceFolder(folderPath)
                )
            } catch {
                return false
            }
        })
        const sorted = existing
            .map(folderPath => path.resolve(folderPath))
            .sort((a, b) => a.length - b.length)
        const pruned: string[] = []
        for (const folderPath of sorted) {
            const hasParent = pruned.some(parent => folderPath.startsWith(parent + path.sep))
            if (!hasParent) {
                pruned.push(folderPath)
            }
        }
        return pruned
    }

    private getNormalizedFileTargets (filePaths: string[], selectedFolders: string[]): string[] {
        const uniqueByKey = new Map<string, string>()
        for (const filePath of filePaths) {
            const key = this.getFsPathKey(filePath)
            if (!key || uniqueByKey.has(key)) {
                continue
            }
            uniqueByKey.set(key, filePath)
        }
        const folderRoots = selectedFolders.map(folderPath => path.resolve(folderPath))
        return Array.from(uniqueByKey.values())
            .map(filePath => path.resolve(filePath))
            .filter(filePath => {
                try {
                    if (!fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) {
                        return false
                    }
                } catch {
                    return false
                }
                return !folderRoots.some(folderPath => filePath.startsWith(folderPath + path.sep))
            })
    }

    private getSelectedActionTargets (fallbackFiles: string[] = [], fallbackFolders: string[] = []): { fileTargets: string[], folderTargets: string[] } {
        const selectedFiles = this.getSelectedFilePathsFromTree()
        const selectedFolders = this.getSelectedFolderPathsFromTree()
        const selectedFolderTargets = this.getNormalizedFolderTargets(selectedFolders)
        const selectedFileTargets = this.getNormalizedFileTargets(selectedFiles, selectedFolderTargets)
        if (
            selectedFileTargets.length
            || selectedFolderTargets.length
            || (!fallbackFiles.length && !fallbackFolders.length)
        ) {
            return {
                fileTargets: selectedFileTargets,
                folderTargets: selectedFolderTargets,
            }
        }

        // Selection can be stale (hidden/removed/protected paths). In that case,
        // honor explicit caller fallback targets (e.g. right-clicked item).
        const fallbackFolderTargets = this.getNormalizedFolderTargets(fallbackFolders)
        const fallbackFileTargets = this.getNormalizedFileTargets(fallbackFiles, fallbackFolderTargets)
        return {
            fileTargets: fallbackFileTargets,
            folderTargets: fallbackFolderTargets,
        }
    }

    private async buildTree (buildNonce: number): Promise<TreeBuildResult> {
        const isStale = (): boolean => buildNonce !== this.treeBuildNonce
        const docsByPath = new Map<string, EditorDocument>()
        for (const doc of this.documents) {
            const candidatePaths = [doc.path, !doc.path ? (doc.tempPath ?? null) : null]
            for (const candidatePath of candidatePaths) {
                const docPathKey = this.normalizeFsPath(candidatePath)
                if (docPathKey) {
                    docsByPath.set(docPathKey, doc)
                }
            }
        }

        let remainingBudget = this.treeNodeBudget
        let truncated = false

        const readDir = async (dir: string, rootPath: string): Promise<TreeNode[]> => {
            if (isStale()) {
                return []
            }
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true }) as any[]
                const nodes: TreeNode[] = []
                const scopedFiles = this.getScopedExternalFiles(rootPath)
                const treeMode = this.getFolderTreeMode(rootPath)
                for (const entry of entries) {
                    if (isStale()) {
                        return []
                    }
                    if (remainingBudget <= 0) {
                        truncated = true
                        break
                    }
                    const name = entry?.name
                    if (!name || name === '.' || name === '..') {
                        continue
                    }
                    const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false
                    if (isDir && this.skippedFolders.has(name)) {
                        continue
                    }
                    remainingBudget--
                    const fullPath = path.join(dir, name)
                    if (!this.simpleDiskMode && this.hiddenTreePathKeys.has(this.toTreePathKey(fullPath) ?? '')) {
                        continue
                    }
                    if (!this.shouldIncludeScopedTreeEntry(scopedFiles, treeMode, fullPath, isDir)) {
                        continue
                    }
                    if (isDir) {
                        nodes.push({
                            name,
                            path: fullPath,
                            isFolder: true,
                            children: [],
                            folderPath: fullPath,
                        })
                    } else {
                        const docPathKey = this.normalizeFsPath(fullPath)
                        const doc = (docPathKey ? docsByPath.get(docPathKey) : null) ?? null
                        nodes.push({
                            name,
                            path: fullPath,
                            isFolder: false,
                            children: [],
                            docId: doc?.id ?? null,
                            folderPath: dir,
                        })
                    }
                }
                nodes.sort((a, b) => {
                    if (a.isFolder !== b.isFolder) {
                        return a.isFolder ? -1 : 1
                    }
                    return a.name.localeCompare(b.name)
                })
                return nodes
            } catch (err: any) {
                console.debug('[readDir] Failed to read', dir, err?.message ?? err)
                return []
            }
        }

        const populate = async (node: TreeNode, rootPath: string): Promise<void> => {
            if (!node.isFolder || isStale() || truncated) {
                return
            }
            const key = node.path || ''
            if (!this.expandedFolders.has(key)) {
                node.children = []
                return
            }
            node.children = await readDir(node.path, rootPath)
            for (const child of node.children) {
                if (child.isFolder) {
                    await populate(child, rootPath)
                }
                if (isStale() || truncated) {
                    return
                }
            }
        }

        const roots: TreeNode[] = []
        for (const folder of this.folders) {
            if (isStale()) {
                return { roots: [], truncated: false }
            }
            const root: TreeNode = {
                name: folder.name,
                path: folder.path,
                isFolder: true,
                children: [],
                folderPath: folder.path,
            }
            await populate(root, root.path)
            roots.push(root)
            if (truncated) {
                break
            }
        }

        return { roots, truncated }
    }

    async addFolder (): Promise<void> {
        const selectedFile = this.getSelectedFilePathsFromTree()[0] ?? null
        const parentFolder = this.selectedFolderPath ?? (selectedFile ? path.dirname(selectedFile) : this.folderRoot)
        await this.createFolderInFolder(parentFolder)
    }

    async openFolderFromDisk (): Promise<void> {
        const input = await this.promptForName('Enter folder path', '')
        const folderPath = (input ?? '').trim()
        if (!folderPath) {
            return
        }
        if (!fsSync.existsSync(folderPath) || !fsSync.statSync(folderPath).isDirectory()) {
            this.setError('Folder does not exist')
            return
        }
        this.attachFolderToTree(folderPath, true)
    }

    private attachFolderToTree (folderPath: string, selectFolder = true, scopeToFilePath: string|null = null): void {
        const resolved = path.resolve(folderPath)
        const localRoot = path.resolve(this.folderRoot)
        const isNestedLocalPath = this.isTreePathEqualOrDescendant(resolved, localRoot) && !this.isSameFsPath(resolved, localRoot)
        if (isNestedLocalPath) {
            // Keep everything under Tlink Studio represented by its single root.
            const rootExists = this.folders.some(folder => this.isSameFsPath(folder.path, localRoot))
            if (!rootExists) {
                this.folders.unshift({ name: this.getFolderDisplayName(localRoot), path: localRoot })
            }
            this.pruneNestedWorkspaceFolders(localRoot)
            if (scopeToFilePath) {
                this.setRootModeToOpenedFiles(localRoot, scopeToFilePath)
            } else if (this.getFolderTreeMode(localRoot) === 'opened') {
                this.syncOpenedFileScopeForRoot(localRoot)
            } else {
                this.setRootModeToFullFolder(localRoot)
            }
            this.expandedFolders.add(localRoot)
            this.expandedFolders.add(resolved)
            this.revealLocalFolderPath(localRoot, resolved)
            if (selectFolder) {
                this.selectFolder(resolved)
            } else {
                this.persistFolders()
            }
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
            return
        }
        const existing = this.folders.find(f => this.isSameFsPath(f.path, resolved))
        if (existing) {
            existing.path = resolved
            existing.name = this.getFolderDisplayName(resolved)
        } else {
            this.folders.push({ name: this.getFolderDisplayName(resolved), path: resolved })
        }
        if (scopeToFilePath) {
            this.setRootModeToOpenedFiles(resolved, scopeToFilePath)
        } else if (this.getFolderTreeMode(resolved) === 'opened') {
            this.syncOpenedFileScopeForRoot(resolved)
        } else {
            this.setRootModeToFullFolder(resolved)
        }
        this.revealTreePath(resolved, true)
        if (selectFolder) {
            this.selectFolder(resolved)
        } else {
            this.persistFolders()
        }
        this.expandedFolders.add(resolved)
        this.updateTreeItems()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
    }

    private pruneNestedWorkspaceFolders (rootPath: string): void {
        const root = path.resolve(rootPath)
        const next: CodeFolder[] = []
        let changed = false
        for (const folder of this.folders) {
            const resolved = path.resolve(folder.path)
            const isNestedLocal = this.isTreePathEqualOrDescendant(resolved, root) && !this.isSameFsPath(resolved, root)
            if (isNestedLocal) {
                changed = true
                continue
            }
            if (next.some(item => this.isSameFsPath(item.path, resolved))) {
                changed = true
                continue
            }
            next.push({ path: resolved, name: this.getFolderDisplayName(resolved) })
        }
        if (!changed) {
            return
        }
        this.folders = next
        this.persistFolders()
        this.updateTreeItems()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
    }

    private revealLocalFolderPath (localRoot: string, folderPath: string): void {
        const root = path.resolve(localRoot)
        const target = path.resolve(folderPath)
        if (!this.isTreePathEqualOrDescendant(target, root)) {
            return
        }

        const chain: string[] = []
        let cursor = target
        while (true) {
            chain.push(cursor)
            if (this.isSameFsPath(cursor, root)) {
                break
            }
            const parent = path.dirname(cursor)
            if (parent === cursor) {
                break
            }
            cursor = parent
        }
        for (const dir of chain) {
            this.revealTreePath(dir, true)
            this.expandedFolders.add(dir)
        }
        this.selectFolder(target)
        this.persistFolders()
        this.updateTreeItems()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
    }

    async renameFolder (folderPath: string): Promise<void> {
        const folder = this.folders.find(f => f.path === folderPath)
        if (!folder) {
            return
        }
        const nextName = (await this.promptForName('Rename folder', folder.name))?.trim()
        if (!nextName || nextName === folder.name) {
            return
        }
        if (/[\\/]/.test(nextName)) {
            this.setError('Folder name cannot contain slashes')
            return
        }
        const parent = path.dirname(folder.path)
        const newPath = path.join(parent, nextName)
        if (fsSync.existsSync(newPath)) {
            this.setError('A folder with that name already exists')
            return
        }
        try {
            await fs.rename(folder.path, newPath)
            this.updatePathsForFolderRename(folder.path, newPath)
            this.migrateRootTreeStateOnRename(folder.path, newPath)
            folder.path = newPath
            folder.name = nextName
            if (this.selectedFolderPath === folderPath) {
                this.selectedFolderPath = newPath
            }
            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath)
                this.expandedFolders.add(newPath)
            }
            this.persistFolders()
            this.persistState()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        } catch (err: any) {
            this.setError(`Failed to rename folder: ${err?.message ?? err}`)
        }
    }

    private async updatePathsForFolderRename (oldPath: string, newPath: string): Promise<void> {
        for (const doc of this.documents) {
            const folderPath = this.resolveDocFolder(doc)
            if (folderPath === oldPath) {
                doc.folderPath = newPath
            }
            if (doc.path && doc.path.startsWith(oldPath)) {
                const rel = path.relative(oldPath, doc.path)
                const dest = path.join(newPath, rel)
                try {
                    await fs.mkdir(path.dirname(dest), { recursive: true })
                    await fs.rename(doc.path, dest)
                    doc.path = dest
                    doc.name = path.basename(dest)
                } catch {
                    // leave as-is on failure
                }
            } else if (!doc.path && doc.tempPath && doc.tempPath.startsWith(oldPath)) {
                const rel = path.relative(oldPath, doc.tempPath)
                const dest = path.join(newPath, rel)
                try {
                    await fs.mkdir(path.dirname(dest), { recursive: true })
                    await fs.rename(doc.tempPath, dest)
                    doc.tempPath = dest
                } catch {
                    // ignore temp move errors
                }
            }
        }
    }

    private migrateRootTreeStateOnRename (oldPath: string, newPath: string): void {
        const oldKey = this.getFsPathKey(oldPath)
        const wasOpenedMode = this.getFolderTreeMode(oldPath) === 'opened'
        this.setFolderTreeMode(oldPath, 'full')
        if (oldKey) {
            this.externalFileScopedRoots.delete(oldKey)
        }
        if (!wasOpenedMode) {
            return
        }
        this.setFolderTreeMode(newPath, 'opened')
        this.syncOpenedFileScopeForRoot(newPath)
    }

    removeFolder (folderPath: string): void {
        if (this.isSameFsPath(folderPath, this.folderRoot)) {
            const localRoot = this.ensureWorkspaceRootAttached()
            this.selectedFolderPath = localRoot
            this.expandedFolders.add(localRoot)
            this.persistFolders()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
            return
        }
        this.folders = this.folders.filter(f => f.path !== folderPath)
        if (this.selectedFolderPath === folderPath) {
            this.selectedFolderPath = null
        }
        this.expandedFolders.delete(folderPath)
        this.setRootModeToFullFolder(folderPath)
        const folderKey = this.toTreePathKey(folderPath)
        if (folderKey && this.hiddenTreePathKeys.has(folderKey)) {
            this.hiddenTreePathKeys.delete(folderKey)
        }
        this.persistFolders()
        this.updateTreeItems()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
    }

    openFolderContextMenu (event: MouseEvent, folderPath: string): void {
        if (!folderPath) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.folderContextMenuPaths = this.getSelectedFolderPathsFromTree()
        if (!this.folderContextMenuPaths.length) {
            this.folderContextMenuPaths = [folderPath]
        }
        this.fileContextMenuPaths = this.getSelectedFilePathsFromTree()
        this.folderContextMenuOpen = true
        this.folderContextMenuPath = folderPath
        this.folderContextScopeRoot = this.getWorkspaceRootForPath(folderPath)
        this.folderContextScopeMode = this.getFolderTreeMode(this.folderContextScopeRoot)
        const menuWidth = 220
        const menuHeight = 220
        const padding = 8
        const maxX = Math.max(padding, (window.innerWidth || 0) - menuWidth - padding)
        const maxY = Math.max(padding, (window.innerHeight || 0) - menuHeight - padding)
        this.folderContextMenuX = Math.max(padding, Math.min(event.clientX, maxX))
        this.folderContextMenuY = Math.max(padding, Math.min(event.clientY, maxY))
    }

    openFileContextMenu (event: MouseEvent, filePath: string): void {
        event.preventDefault()
        event.stopPropagation()
        this.fileContextMenuOpen = true
        this.fileContextMenuPath = filePath
        if (!this.fileContextMenuPaths.length) {
            this.fileContextMenuPaths = [filePath]
        }
        this.folderContextMenuPaths = this.getSelectedFolderPathsFromTree()
        const menuWidth = 220
        const menuHeight = 220
        const padding = 8
        const maxX = Math.max(padding, (window.innerWidth || 0) - menuWidth - padding)
        const maxY = Math.max(padding, (window.innerHeight || 0) - menuHeight - padding)
        this.fileContextMenuX = Math.max(padding, Math.min(event.clientX, maxX))
        this.fileContextMenuY = Math.max(padding, Math.min(event.clientY, maxY))
    }

    async handleFolderContextAction (action: string): Promise<void> {
        const selected = this.getSelectedActionTargets(this.fileContextMenuPaths, this.folderContextMenuPaths)
        const folderPath = this.folderContextMenuPath
        const fileTargets = selected.fileTargets.length
            ? selected.fileTargets
            : (this.fileContextMenuPaths.length ? this.getNormalizedFileTargets(this.fileContextMenuPaths, []) : [])
        const folderTargets = selected.folderTargets.length
            ? selected.folderTargets
            : (folderPath ? this.getNormalizedFolderTargets([folderPath]) : [])
        const scopeRoot = this.folderContextScopeRoot
        this.folderContextMenuOpen = false
        this.folderContextMenuPath = null
        this.folderContextMenuPaths = []
        this.folderContextScopeRoot = null
        this.folderContextScopeMode = 'full'
        if (!folderPath) {
            return
        }
        if (action === 'newFolder') {
            await this.createFolderInFolder(folderPath)
        } else if (action === 'newFile') {
            await this.createFileInFolder(folderPath)
        } else if (action === 'newTopology') {
            await this.createTopologyInFolder(folderPath)
        } else if (action === 'rename') {
            if (this.isProtectedWorkspaceFolder(folderPath)) {
                this.setError('Tlink Studio folder is protected and cannot be renamed')
                return
            }
            if (this.folders.find(f => this.isSameFsPath(f.path, folderPath))) {
                await this.renameFolder(folderPath)
            } else {
                await this.renameFolderOnDisk(folderPath)
            }
        } else if (action === 'remove') {
            if (this.isProtectedWorkspaceFolder(folderPath)) {
                return
            }
            if (this.folders.find(f => this.isSameFsPath(f.path, folderPath))) {
                this.removeFolder(folderPath)
            }
        } else if (action === 'open') {
            try {
                this.platform.showItemInFolder(folderPath)
            } catch {
                // ignore
            }
        } else if (action === 'scopeToggle') {
            if (scopeRoot) {
                this.toggleRootScopeMode(scopeRoot)
            }
        } else if (action === 'duplicate') {
            await this.duplicateSelectionOnDisk(fileTargets, folderTargets)
        } else if (action === 'move') {
            await this.moveSelectionToFolderPrompt(fileTargets, folderTargets)
        } else if (action === 'delete') {
            await this.deleteSelectionOnDisk(fileTargets, folderTargets)
        }
    }

    async handleFileContextAction (action: string): Promise<void> {
        const filePath = this.fileContextMenuPath
        const selected = this.getSelectedActionTargets(
            this.fileContextMenuPaths.length
            ? [...this.fileContextMenuPaths]
            : (filePath ? [filePath] : []),
            this.folderContextMenuPaths.length ? [...this.folderContextMenuPaths] : [],
        )
        const fileTargets = selected.fileTargets.length
            ? selected.fileTargets
            : (filePath ? this.getNormalizedFileTargets([filePath], []) : [])
        const folderTargets = selected.folderTargets.length
            ? selected.folderTargets
            : (this.folderContextMenuPaths.length ? this.getNormalizedFolderTargets(this.folderContextMenuPaths) : [])
        this.fileContextMenuOpen = false
        this.fileContextMenuPath = null
        this.fileContextMenuPaths = []
        this.folderContextMenuPaths = []
        if (!filePath) {
            return
        }
        if (action === 'open') {
            await this.openFileFromDiskPath(filePath)
        } else if (action === 'rename') {
            await this.renameFileOnDisk(filePath)
        } else if (action === 'show') {
            try {
                this.platform.showItemInFolder(filePath)
            } catch {}
        } else if (action === 'duplicate') {
            await this.duplicateSelectionOnDisk(fileTargets, folderTargets)
        } else if (action === 'move') {
            await this.moveSelectionToFolderPrompt(fileTargets, folderTargets)
        } else if (action === 'delete') {
            await this.deleteSelectionOnDisk(fileTargets, folderTargets)
        }
    }

    private async openFileFromDiskPath (filePath: string, syncTreeSelection = true): Promise<void> {
        try {
            const resolved = path.resolve(filePath)
            this.ensurePathVisibleInTree(resolved, false, true)
            this.revealTreePath(resolved)
            const content = await fs.readFile(resolved, 'utf8')
            this.openDocumentFromContent(path.basename(resolved), resolved, content, syncTreeSelection)
        } catch (err: any) {
            this.setError(`Failed to open file: ${err?.message ?? err}`)
        }
    }

    private async createFolderInFolder (parentFolder: string): Promise<void> {
        const resolvedParent = this.resolveFolderCreationParent(parentFolder)
        const defaultName = this.getNextAvailableFolderName(resolvedParent, 'Folder')
        const name = (await this.promptForName('New folder name', defaultName))?.trim()
        if (!name) {
            return
        }
        if (/[\\/]/.test(name)) {
            this.setError('Folder name cannot contain slashes')
            return
        }
        let target = path.join(resolvedParent, name)
        if (fsSync.existsSync(target)) {
            target = await this.ensureUniquePath(resolvedParent, name)
        }
        try {
            await fs.mkdir(target, { recursive: false })
            const workspaceRoot = this.getWorkspaceRootForPath(target)
            if (workspaceRoot && this.getFolderTreeMode(workspaceRoot) === 'opened') {
                this.setRootModeToFullFolder(workspaceRoot)
            }
            if (workspaceRoot) {
                this.expandPathWithinRoot(workspaceRoot, target)
            }
            this.revealTreePath(resolvedParent, true)
            this.revealTreePath(target, true)
            // Keep creation parent selected so repeated "New folder" actions
            // create sibling folders, not nested folders by default.
            this.selectFolder(resolvedParent)
            this.expandedFolders.add(resolvedParent)
            this.persistFolders()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        } catch (err: any) {
            this.setError(`Cannot create folder: ${err?.message ?? err}`)
        }
    }

    private resolveFolderCreationParent (preferredParent: string|null|undefined): string {
        const fallbackRoot = this.ensureWorkspaceRootAttached()
        const candidates: Array<string|null|undefined> = [
            preferredParent,
            this.selectedFolderPath,
            this.getSelectedFilePathsFromTree()[0] ? path.dirname(this.getSelectedFilePathsFromTree()[0]) : null,
            fallbackRoot,
        ]
        for (const candidate of candidates) {
            if (!candidate) {
                continue
            }
            const resolved = path.resolve(candidate)
            try {
                const stat = fsSync.statSync(resolved)
                if (stat.isDirectory()) {
                    return resolved
                }
                if (stat.isFile()) {
                    const dir = path.dirname(resolved)
                    if (fsSync.existsSync(dir) && fsSync.statSync(dir).isDirectory()) {
                        return dir
                    }
                }
            } catch {
                // try next candidate
            }
        }
        try {
            fsSync.mkdirSync(fallbackRoot, { recursive: true })
        } catch {
            // best effort; caller will surface any error on create
        }
        return fallbackRoot
    }

    private getNextAvailableFolderName (parentFolder: string, baseName: string): string {
        const resolvedParent = path.resolve(parentFolder)
        let index = 0
        while (true) {
            const candidate = index === 0 ? baseName : `${baseName}-${index}`
            const target = path.join(resolvedParent, candidate)
            if (!fsSync.existsSync(target)) {
                return candidate
            }
            index++
        }
    }

    private getNextAvailableFileName (parentFolder: string, baseName: string): string {
        const resolvedParent = path.resolve(parentFolder)
        const ext = path.extname(baseName)
        const stem = path.basename(baseName, ext)
        let index = 0
        while (true) {
            const candidate = index === 0 ? baseName : `${stem}-${index}${ext}`
            const target = path.join(resolvedParent, candidate)
            if (!fsSync.existsSync(target)) {
                return candidate
            }
            index++
        }
    }

    private buildTopologyTemplateContent (fileName: string): string {
        const topologyName = path.basename(fileName, path.extname(fileName))
        return `${JSON.stringify({
            schemaVersion: '1.0',
            type: 'tlink-topology',
            name: topologyName,
            nodes: [
                {
                    id: 'router-1',
                    type: 'router',
                    label: 'Router 1',
                    x: 120,
                    y: 120,
                    width: this.topologyNodeWidthPx,
                    height: this.topologyNodeHeightPx,
                    color: this.getTopologyDefaultNodeColor(),
                },
                {
                    id: 'switch-1',
                    type: 'switch',
                    label: 'Switch 1',
                    x: 360,
                    y: 220,
                    width: this.topologyNodeWidthPx,
                    height: this.topologyNodeHeightPx,
                    color: this.getTopologyDefaultNodeColor(),
                },
            ],
            links: [
                {
                    id: 'link-1',
                    from: 'router-1',
                    to: 'switch-1',
                    label: 'ge-0/0/0',
                    color: this.getTopologyDefaultLinkColor(),
                    directed: true,
                },
            ],
            shapes: [],
            texts: [],
            metadata: {
                createdBy: 'tlink-studio',
                createdAt: new Date().toISOString(),
            },
        }, null, 2)}\n`
    }

    private async createFileInFolder (parentFolder: string): Promise<void> {
        const resolvedParent = this.resolveFolderCreationParent(parentFolder)
        const name = (await this.promptForName('New file name', 'file.txt'))?.trim()
        if (!name) {
            return
        }
        if (/[\\/]/.test(name)) {
            this.setError('File name cannot contain slashes')
            return
        }
        const target = path.join(resolvedParent, name)
        if (fsSync.existsSync(target)) {
            this.setError('A file with that name already exists')
            return
        }
        try {
            await fs.mkdir(resolvedParent, { recursive: true })
            await fs.writeFile(target, '', 'utf8')
            this.openDocumentFromContent(path.basename(target), target, '')
            this.revealTreePath(resolvedParent, true)
            this.expandedFolders.add(resolvedParent)
            this.persistFolders()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        } catch (err: any) {
            this.setError(`Cannot create file: ${err?.message ?? err}`)
        }
    }

    private async createTopologyInFolder (parentFolder: string): Promise<void> {
        const resolvedParent = this.resolveFolderCreationParent(parentFolder)
        const defaultName = this.getNextAvailableFileName(resolvedParent, 'topology.topology.json')
        const providedName = (await this.promptForName('New topology file name', defaultName))?.trim()
        if (!providedName) {
            return
        }
        if (/[\\/]/.test(providedName)) {
            this.setError('File name cannot contain slashes')
            return
        }
        const normalizedName = providedName.toLowerCase().endsWith('.json') ? providedName : `${providedName}.json`
        let target = path.join(resolvedParent, normalizedName)
        if (fsSync.existsSync(target)) {
            target = await this.ensureUniquePath(resolvedParent, normalizedName)
        }
        try {
            await fs.mkdir(resolvedParent, { recursive: true })
            const content = this.buildTopologyTemplateContent(path.basename(target))
            await fs.writeFile(target, content, 'utf8')
            this.openDocumentFromContent(path.basename(target), target, content)
            this.revealTreePath(resolvedParent, true)
            this.expandedFolders.add(resolvedParent)
            this.persistFolders()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        } catch (err: any) {
            this.setError(`Cannot create topology: ${err?.message ?? err}`)
        }
    }

    private async renameFolderOnDisk (folderPath: string): Promise<void> {
        const nextName = (await this.promptForName('Rename folder', path.basename(folderPath) || folderPath))?.trim()
        if (!nextName) {
            return
        }
        if (/[\\/]/.test(nextName)) {
            this.setError('Folder name cannot contain slashes')
            return
        }
        const parent = path.dirname(folderPath)
        const newPath = path.join(parent, nextName)
        if (fsSync.existsSync(newPath)) {
            this.setError('A folder with that name already exists')
            return
        }
        try {
            await fs.rename(folderPath, newPath)
            if (this.selectedFolderPath === folderPath) {
                this.selectedFolderPath = newPath
            }
            if (this.expandedFolders.has(folderPath)) {
                this.expandedFolders.delete(folderPath)
                this.expandedFolders.add(newPath)
            }
            this.updatePathsForFolderRename(folderPath, newPath)
            this.syncOpenedFileScopes()
            this.persistFolders()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        } catch (err: any) {
            this.setError(`Failed to rename folder: ${err?.message ?? err}`)
        }
    }

    private async renameFileOnDisk (filePath: string): Promise<void> {
        const nextName = (await this.promptForName('Rename file', path.basename(filePath) || filePath))?.trim()
        if (!nextName) {
            return
        }
        if (/[\\/]/.test(nextName)) {
            this.setError('File name cannot contain slashes')
            return
        }
        const parent = path.dirname(filePath)
        const newPath = path.join(parent, nextName)
        if (fsSync.existsSync(newPath)) {
            this.setError('A file with that name already exists')
            return
        }
        const oldKeyBeforeRename = this.getFsPathKey(filePath)
        try {
            await fs.rename(filePath, newPath)
            this.updateOpenDocsForFsMove(filePath, newPath, false)
            this.remapFileSelectionPath(filePath, newPath, oldKeyBeforeRename)
            this.revealTreePath(newPath)
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
            this.persistState()
        } catch (err: any) {
            this.setError(`Failed to rename file: ${err?.message ?? err}`)
        }
    }

    private async deleteFilesOnDisk (filePaths: string[], skipConfirm = false): Promise<number> {
        const uniqueByKey = new Map<string, string>()
        for (const filePath of filePaths) {
            const key = this.getFsPathKey(filePath)
            if (!key) {
                continue
            }
            if (!uniqueByKey.has(key)) {
                uniqueByKey.set(key, filePath)
            }
        }
        const targets = Array.from(uniqueByKey.values()).filter(filePath => {
            try {
                return fsSync.existsSync(filePath) && fsSync.statSync(filePath).isFile()
            } catch {
                return false
            }
        })
        if (!targets.length) {
            return 0
        }
        if (!skipConfirm) {
            const detail = targets.length === 1
                ? 'This action cannot be undone.'
                : 'This action cannot be undone and will remove all selected files.'
            if (!(await this.confirmAction(
                `Delete ${targets.length} file${targets.length === 1 ? '' : 's'}?`,
                detail,
                'Delete',
            ))) {
                return 0
            }
        }
        let deletedCount = 0
        for (const filePath of targets) {
            const existedBefore = fsSync.existsSync(filePath)
            await this.deleteFileOnDisk(filePath, true)
            if (existedBefore && !fsSync.existsSync(filePath)) {
                deletedCount++
            }
        }
        if (deletedCount > 1) {
            this.statusMessage = `Deleted ${deletedCount} files`
            this.updateStatus()
        }
        return deletedCount
    }

    private async deleteFoldersOnDisk (folderPaths: string[], skipConfirm = false): Promise<number> {
        const targets = this.getNormalizedFolderTargets(folderPaths)
        if (!targets.length) {
            return 0
        }
        if (!skipConfirm) {
            const detail = targets.length === 1
                ? 'This action cannot be undone and will remove all files inside this folder.'
                : 'This action cannot be undone and will remove all selected folders and their contents.'
            if (!(await this.confirmAction(
                `Delete ${targets.length} folder${targets.length === 1 ? '' : 's'}?`,
                detail,
                'Delete',
            ))) {
                return 0
            }
        }
        let deletedCount = 0
        for (const folderPath of targets) {
            const existedBefore = fsSync.existsSync(folderPath)
            await this.deleteFolderOnDisk(folderPath, true)
            if (existedBefore && !fsSync.existsSync(folderPath)) {
                deletedCount++
            }
        }
        if (deletedCount > 1) {
            this.statusMessage = `Deleted ${deletedCount} folders`
            this.updateStatus()
        }
        return deletedCount
    }

    private async deleteSelectionOnDisk (filePaths: string[], folderPaths: string[]): Promise<void> {
        // Re-entrancy guard: prevent multiple concurrent delete operations
        // (e.g. from key repeat on Delete/Backspace) which can stack modal
        // dialogs and freeze the UI.
        if (this.deleteInProgress) {
            return
        }
        this.deleteInProgress = true
        try {
            const folderTargets = this.getNormalizedFolderTargets(folderPaths)
            const fileTargets = this.getNormalizedFileTargets(filePaths, folderTargets)
            const total = fileTargets.length + folderTargets.length
            if (!total) {
                this.setError('No deletable files or folders selected')
                return
            }
            if (this.simpleDiskMode) {
                await this.deleteSelectionOnDiskSimple(fileTargets, folderTargets)
                return
            }
            if (!this.simpleDiskMode) {
                const detailParts: string[] = []
                if (fileTargets.length) {
                    detailParts.push(`${fileTargets.length} file${fileTargets.length === 1 ? '' : 's'}`)
                }
                if (folderTargets.length) {
                    detailParts.push(`${folderTargets.length} folder${folderTargets.length === 1 ? '' : 's'}`)
                }
                if (!(await this.confirmAction(
                    `Delete ${total} item${total === 1 ? '' : 's'}?`,
                    `This action cannot be undone and will remove ${detailParts.join(' and ')}.`,
                    'Delete',
                ))) {
                    return
                }
            }

            const deletedFiles = await this.deleteFilesOnDisk(fileTargets, true)
            const deletedFolders = await this.deleteFoldersOnDisk(folderTargets, true)
            const deletedTotal = deletedFiles + deletedFolders
            if (deletedTotal > 1) {
                this.statusMessage = `Deleted ${deletedTotal} items`
                this.updateStatus()
            }
        } finally {
            this.deleteInProgress = false
        }
    }

    private async deleteSelectionOnDiskSimple (fileTargets: string[], folderTargets: string[]): Promise<void> {
        const toDeleteFileKeys = new Set<string>()
        const toDeleteFolderKeys = new Set<string>()
        for (const filePath of fileTargets) {
            const key = this.getFsPathKey(filePath)
            if (key) {
                toDeleteFileKeys.add(key)
            }
        }
        for (const folderPath of folderTargets) {
            const key = this.getFsPathKey(folderPath)
            if (key) {
                toDeleteFolderKeys.add(key)
            }
        }

        const docsToClose = this.documents.filter(doc => {
            const docPath = doc.path ?? doc.tempPath ?? null
            const docKey = this.getFsPathKey(docPath)
            if (!docKey) {
                return false
            }
            if (toDeleteFileKeys.has(docKey)) {
                return true
            }
            for (const folderKey of toDeleteFolderKeys) {
                if (docKey === folderKey || docKey.startsWith(folderKey + path.sep)) {
                    return true
                }
            }
            return false
        })
        for (const doc of docsToClose) {
            doc.isDirty = false
            await this.closeDocument(doc.id, true, true)
        }

        let deletedFiles = 0
        for (const filePath of fileTargets) {
            try {
                fsSync.rmSync(filePath, { force: true })
                if (!fsSync.existsSync(filePath)) {
                    deletedFiles++
                }
            } catch (err: any) {
                console.error('[deleteSelectionOnDiskSimple:file]', filePath, err?.message ?? err)
            }
        }

        let deletedFolders = 0
        for (const folderPath of folderTargets) {
            if (this.isProtectedWorkspaceFolder(folderPath)) {
                continue
            }
            try {
                fsSync.rmSync(folderPath, { recursive: true, force: true })
                if (!fsSync.existsSync(folderPath)) {
                    deletedFolders++
                }
            } catch (err: any) {
                console.error('[deleteSelectionOnDiskSimple:folder]', folderPath, err?.message ?? err)
            }
        }

        for (const folderPath of folderTargets) {
            if (this.folders.find(f => this.isSameFsPath(f.path, folderPath)) && !this.isProtectedWorkspaceFolder(folderPath)) {
                this.removeFolder(folderPath)
            }
        }
        if (this.selectedFolderPath && folderTargets.some(folderPath => this.isTreePathEqualOrDescendant(this.selectedFolderPath, folderPath))) {
            this.selectedFolderPath = this.getFolderForPath(this.selectedFolderPath)
        }
        if (fileTargets.length || folderTargets.length) {
            this.selectedFilePathKeys = new Set()
            this.selectedFolderPathKeys = new Set()
            this.fileSelectionAnchorKey = null
            this.folderSelectionAnchorKey = null
        }
        this.persistFolders()
        this.persistState()
        this.updateTreeItems()
        this.updateStatus()
        const deletedTotal = deletedFiles + deletedFolders
        this.statusMessage = `Deleted ${deletedTotal} item${deletedTotal === 1 ? '' : 's'}`
        if (!deletedTotal) {
            this.setError('Delete failed: no items were removed from disk')
        }
        window.setTimeout(() => this.cdr.markForCheck(), 0)
    }

    private async deleteFileOnDisk (filePath: string, skipConfirm = false): Promise<void> {
        const relatedDocs = this.documents.filter(doc =>
            this.isSameFsPath(doc.path, filePath) || this.isSameFsPath(doc.tempPath ?? null, filePath),
        )
        if (!this.simpleDiskMode) {
            for (const doc of relatedDocs) {
                if (doc.isDirty && !(await this.confirmDiscard(doc))) {
                    return
                }
            }
        }
        if (!this.simpleDiskMode && !skipConfirm) {
            if (!(await this.confirmAction(
                `Delete ${path.basename(filePath)}?`,
                'This action cannot be undone.',
                'Delete',
            ))) {
                return
            }
        }
        const filePathKey = this.getFsPathKey(filePath)
        if (filePathKey) {
            this.deletingPathKeys.add(filePathKey)
        }
        for (const doc of relatedDocs) {
            // Prevent autosave from writing this file while delete is in progress.
            doc.isDirty = false
            if (this.isModelAlive(doc)) {
                doc.lastSavedValue = doc.model.getValue()
            }
        }
        try {
            await fs.unlink(filePath)
            // Hide the deleted path so it never briefly reappears during
            // tree rebuilds triggered by closeDocument / persistState.
            this.hideTreePath(filePath)
            for (const doc of relatedDocs) {
                // Mark non-dirty and force-close: skip confirmDiscard dialog
                // and skip per-doc updateTreeItems/updateStatus to avoid
                // cascading filesystem reads and Angular change detection
                // cycles inside the loop.
                doc.isDirty = false
                if (this.isModelAlive(doc)) {
                    doc.lastSavedValue = doc.model.getValue()
                }
                await this.closeDocument(doc.id, true, true)
            }
            if (filePathKey) {
                this.selectedFilePathKeys.delete(filePathKey)
                if (this.fileSelectionAnchorKey === filePathKey) {
                    this.fileSelectionAnchorKey = null
                }
            }
            // All docs are closed with deferred persistence; flush once now.
            this.persistState()
            // Single tree + UI update after all docs are closed, instead
            // of per-doc updates inside the loop.
            this.updateTreeItems()
            this.statusMessage = `Deleted: ${path.basename(filePath)}`
            this.updateStatus()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        } catch (err: any) {
            this.setError(`Failed to delete file: ${err?.message ?? err}`)
        } finally {
            if (filePathKey) {
                this.deletingPathKeys.delete(filePathKey)
            }
        }
    }

    private async deleteActiveFileOnDisk (): Promise<void> {
        if (this.deleteInProgress) { return }
        const doc = this.getActiveDoc()
        if (!doc?.path) {
            this.setError('Active document is not backed by a file on disk.')
            return
        }
        this.deleteInProgress = true
        try {
            await this.deleteFileOnDisk(doc.path)
        } finally {
            this.deleteInProgress = false
        }
    }

    private async deleteFolderOnDisk (folderPath: string, skipConfirm = false): Promise<void> {
        const localRoot = path.resolve(this.folderRoot)
        const deletingWorkspaceRoot = this.isSameFsPath(folderPath, localRoot)
        if (deletingWorkspaceRoot) {
            this.ensureWorkspaceRootAttached()
            this.setError('Tlink Studio folder is protected and cannot be deleted')
            return
        }
        // Close any open documents in this folder.
        // Confirm dirty docs first, then force-close all in one pass
        // to avoid per-doc tree rebuilds that cascade filesystem reads.
        const docsInFolder = this.documents.filter(doc => {
            const docFolder = this.resolveDocFolder(doc)
            return docFolder === folderPath || (doc.path && doc.path.startsWith(folderPath + path.sep))
        })
        if (!this.simpleDiskMode) {
            for (const doc of docsInFolder) {
                if (doc.isDirty && !(await this.confirmDiscard(doc))) {
                    return
                }
            }
        }

        if (!this.simpleDiskMode && !skipConfirm) {
            if (!(await this.confirmAction(
                `Delete folder ${path.basename(folderPath) || folderPath}?`,
                'All files and subfolders will be permanently removed.',
                'Delete folder',
            ))) {
                return
            }
        }
        // Force-close docs after confirmation so no additional dialogs
        // appear during the close loop.
        for (const doc of docsInFolder) {
            doc.isDirty = false
            await this.closeDocument(doc.id, true, true)
        }
        try {
            // Node 20 supports fs.rm
            await fs.rm(folderPath, { recursive: true, force: this.simpleDiskMode })
            // If it was tracked as a root, remove it from list too
            if (this.folders.find(f => this.isSameFsPath(f.path, folderPath))) {
                this.removeFolder(folderPath)
            }
            if (this.selectedFolderPath === folderPath) {
                this.selectedFolderPath = null
            }
            this.expandedFolders.delete(folderPath)
            this.persistFolders()
            this.persistState()
            this.updateTreeItems()
            this.updateStatus()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        } catch (err: any) {
            this.setError(`Failed to delete folder: ${err?.message ?? err}`)
        }
    }

    private async duplicateFileOnDisk (filePath: string): Promise<boolean> {
        try {
            if (!fsSync.existsSync(filePath) || !fsSync.statSync(filePath).isFile()) {
                return false
            }
        } catch {
            return false
        }
        const parent = path.dirname(filePath)
        const ext = path.extname(filePath)
        const base = path.basename(filePath, ext)
        const destination = await this.ensureUniquePath(parent, `${base}-copy${ext}`)
        try {
            await fs.copyFile(filePath, destination)
            return true
        } catch (err: any) {
            this.setError(`Failed to duplicate file: ${err?.message ?? err}`)
            return false
        }
    }

    private async duplicateFolderOnDisk (folderPath: string): Promise<boolean> {
        try {
            if (!fsSync.existsSync(folderPath) || !fsSync.statSync(folderPath).isDirectory()) {
                return false
            }
        } catch {
            return false
        }
        const parent = path.dirname(folderPath)
        const base = path.basename(folderPath)
        const destination = await this.ensureUniquePath(parent, `${base}-copy`)
        try {
            await fs.cp(folderPath, destination, { recursive: true, force: false })
            return true
        } catch (err: any) {
            this.setError(`Failed to duplicate folder: ${err?.message ?? err}`)
            return false
        }
    }

    private async duplicateSelectionOnDisk (filePaths: string[], folderPaths: string[]): Promise<void> {
        const folderTargets = this.getNormalizedFolderTargets(folderPaths)
        const fileTargets = this.getNormalizedFileTargets(filePaths, folderTargets)
        if (!folderTargets.length && !fileTargets.length) {
            return
        }
        let duplicatedCount = 0
        for (const folderPath of folderTargets) {
            if (await this.duplicateFolderOnDisk(folderPath)) {
                duplicatedCount++
            }
        }
        for (const filePath of fileTargets) {
            if (await this.duplicateFileOnDisk(filePath)) {
                duplicatedCount++
            }
        }
        if (duplicatedCount > 0) {
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
            this.statusMessage = duplicatedCount === 1 ? 'Duplicated 1 item' : `Duplicated ${duplicatedCount} items`
            this.updateStatus()
        }
    }

    private toggleRootScopeMode (rootPath: string): void {
        const currentMode = this.getFolderTreeMode(rootPath)
        if (currentMode === 'opened') {
            this.setRootModeToFullFolder(rootPath)
            this.statusMessage = `Explorer mode: Full folder (${this.getFolderDisplayName(rootPath)})`
        } else {
            this.setRootModeToOpenedFiles(rootPath)
            const scopedCount = this.getScopedExternalFiles(rootPath)?.size ?? 0
            this.statusMessage = scopedCount > 0
                ? `Explorer mode: Opened files only (${this.getFolderDisplayName(rootPath)})`
                : `Explorer mode: Opened files only (${this.getFolderDisplayName(rootPath)}) - no open files`
        }
        this.persistFolders()
        this.updateTreeItems()
        this.updateStatus()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
    }

    private async moveSelectionOnDisk (filePaths: string[], folderPaths: string[], targetDir: string): Promise<number> {
        const folderTargets = this.getNormalizedFolderTargets(folderPaths)
        const fileTargets = this.getNormalizedFileTargets(filePaths, folderTargets)
        if (!folderTargets.length && !fileTargets.length) {
            return 0
        }
        const targetResolved = path.resolve(targetDir)
        let moved = 0
        for (const folderPath of folderTargets) {
            const source = path.resolve(folderPath)
            if (this.isSameFsPath(source, targetResolved)) {
                continue
            }
            if (targetResolved.startsWith(source + path.sep)) {
                this.setError(`Cannot move ${path.basename(source)} into itself`)
                continue
            }
            const destination = await this.ensureUniquePath(targetResolved, path.basename(source))
            await fs.rename(source, destination)
            this.updateOpenDocsForFsMove(source, destination, true)
            moved++
        }
        for (const filePath of fileTargets) {
            const source = path.resolve(filePath)
            if (this.isSameFsPath(path.dirname(source), targetResolved)) {
                continue
            }
            const destination = await this.ensureUniquePath(targetResolved, path.basename(source))
            await fs.rename(source, destination)
            this.updateOpenDocsForFsMove(source, destination, false)
            moved++
        }
        if (moved > 0) {
            this.syncOpenedFileScopes()
            this.persistState()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
            this.statusMessage = moved === 1 ? 'Moved 1 item' : `Moved ${moved} items`
            this.updateStatus()
        }
        return moved
    }

    private async moveSelectionToFolderPrompt (filePaths: string[], folderPaths: string[]): Promise<void> {
        const folderTargets = this.getNormalizedFolderTargets(folderPaths)
        const fileTargets = this.getNormalizedFileTargets(filePaths, folderTargets)
        if (!folderTargets.length && !fileTargets.length) {
            return
        }
        const firstTarget = folderTargets[0] ?? fileTargets[0] ?? this.selectedFolderPath ?? this.folderRoot
        const defaultDir = fsSync.existsSync(firstTarget) && fsSync.statSync(firstTarget).isDirectory()
            ? firstTarget
            : path.dirname(firstTarget)
        const input = await this.promptForName('Move selected items to folder', defaultDir)
        const targetDir = (input ?? '').trim()
        if (!targetDir) {
            return
        }
        if (!fsSync.existsSync(targetDir) || !fsSync.statSync(targetDir).isDirectory()) {
            this.setError('Target folder does not exist')
            return
        }
        try {
            await this.moveSelectionOnDisk(fileTargets, folderTargets, targetDir)
        } catch (err: any) {
            this.setError(`Move failed: ${err?.message ?? err}`)
        }
    }

    private updateOpenDocsForFsMove (oldPath: string, newPath: string, isDir: boolean): void {
        const oldResolved = path.resolve(oldPath)
        const newResolved = path.resolve(newPath)
        for (const doc of this.documents) {
            if (doc.path) {
                const docResolved = path.resolve(doc.path)
                if (isDir) {
                    if (docResolved === oldResolved || docResolved.startsWith(oldResolved + path.sep)) {
                        const rel = path.relative(oldResolved, docResolved)
                        doc.path = path.join(newResolved, rel)
                        doc.name = path.basename(doc.path)
                        doc.folderPath = null
                        this.setModelLanguage(doc)
                        this.refreshDocDiskSnapshot(doc, doc.model.getValue())
                    }
                } else if (docResolved === oldResolved) {
                    doc.path = newResolved
                    doc.name = path.basename(doc.path)
                    doc.folderPath = null
                    this.setModelLanguage(doc)
                    this.refreshDocDiskSnapshot(doc, doc.model.getValue())
                }
            } else if (doc.tempPath) {
                const tempResolved = path.resolve(doc.tempPath)
                if (isDir) {
                    if (tempResolved === oldResolved || tempResolved.startsWith(oldResolved + path.sep)) {
                        const rel = path.relative(oldResolved, tempResolved)
                        doc.tempPath = path.join(newResolved, rel)
                        doc.name = path.basename(doc.tempPath)
                        doc.folderPath = path.dirname(doc.tempPath)
                        this.setModelLanguage(doc)
                    }
                } else if (tempResolved === oldResolved) {
                    doc.tempPath = newResolved
                    doc.name = path.basename(doc.tempPath)
                    doc.folderPath = path.dirname(doc.tempPath)
                    this.setModelLanguage(doc)
                }
            }
        }
        // Update recents list
        this.recentFiles = this.recentFiles.map(p => p === oldPath ? newPath : p).filter(Boolean)
        this.syncOpenedFileScopes()
        this.setStateItem('codeEditor.recent', JSON.stringify(this.recentFiles.slice(0, 10)))
    }

    onTreeDragStart (event: DragEvent, node: TreeNode): void {
        this.draggingDocId = node.docId ?? null
        this.draggingPath = node.path || null
        this.draggingIsFolder = !!node.isFolder
        try {
            if (this.draggingDocId) {
                event.dataTransfer?.setData('application/x-tlink-docid', this.draggingDocId)
            }
            if (this.draggingPath) {
                event.dataTransfer?.setData('application/x-tlink-path', this.draggingPath)
            }
            event.dataTransfer?.setData('text/plain', this.draggingPath || this.draggingDocId || '')
            event.dataTransfer?.setDragImage?.(event.target as any, 0, 0)
        } catch {
            // ignore
        }
    }

    onTreeDragEnd (): void {
        this.draggingDocId = null
        this.draggingPath = null
        this.draggingIsFolder = false
    }

    onTreeDragOver (event: DragEvent): void {
        if (this.draggingDocId || this.draggingPath) {
            event.preventDefault()
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'move'
            }
        }
    }

    async onTreeDrop (event: DragEvent, folderPath: string|null): Promise<void> {
        if (!this.draggingDocId && !this.draggingPath) {
            return
        }
        event.preventDefault()
        event.stopPropagation()

        const targetDir = folderPath || null
        if (!targetDir) {
            return
        }
        try {
            if (!fsSync.existsSync(targetDir) || !fsSync.statSync(targetDir).isDirectory()) {
                return
            }
        } catch {
            return
        }

        // If we're dragging an open document, move it via existing logic (keeps editor model + temp files aligned)
        if (this.draggingDocId) {
            await this.moveDocumentToFolder(this.draggingDocId, targetDir)
            this.draggingDocId = null
            this.draggingPath = null
            this.draggingIsFolder = false
            return
        }

        const sourcePath = this.draggingPath
        const isDir = this.draggingIsFolder
        this.draggingPath = null
        this.draggingIsFolder = false
        if (!sourcePath) {
            return
        }
        const sourceResolved = path.resolve(sourcePath)
        const targetResolved = path.resolve(targetDir)
        if (sourceResolved === targetResolved) {
            return
        }
        if (isDir && targetResolved.startsWith(sourceResolved + path.sep)) {
            this.setError('Cannot move a folder into itself')
            return
        }
        if (path.resolve(path.dirname(sourceResolved)) === targetResolved) {
            return
        }

        const moveSources = new Set<string>()
        if (!isDir) {
            const selectedPaths = this.getSelectedFilePathsFromTree()
            const draggingPathSelected = selectedPaths.some(p => this.isSameFsPath(p, sourceResolved))
            if (draggingPathSelected) {
                for (const selectedPath of selectedPaths) {
                    moveSources.add(path.resolve(selectedPath))
                }
            }
        }
        if (!moveSources.size) {
            moveSources.add(sourceResolved)
        }

        let moved = 0
        try {
            for (const source of moveSources) {
                if (!isDir && path.resolve(path.dirname(source)) === targetResolved) {
                    continue
                }
                const baseName = path.basename(source)
                const dest = await this.ensureUniquePath(targetDir, baseName)
                await fs.rename(source, dest)
                this.updateOpenDocsForFsMove(source, dest, isDir)
                moved++
            }
            if (!moved) {
                return
            }
            this.syncOpenedFileScopes()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
            this.persistState()
        } catch (err: any) {
            this.setError(`Move failed: ${err?.message ?? err}`)
        }
    }

    toggleFolder (event: MouseEvent|null, node: TreeNode): void {
        if (event) {
            event.preventDefault()
            event.stopPropagation()
        }
        if (!node.isFolder) {
            return
        }
        const key = node.path || '__root__'
        const wasExpanded = this.expandedFolders.has(key)
        if (wasExpanded) {
            this.expandedFolders.delete(key)
        } else {
            this.expandedFolders.add(key)
        }
        // Create new Set reference to trigger change detection
        this.expandedFolders = new Set(this.expandedFolders)
        this.persistFolders()
        // Update tree items after state change
        this.updateTreeItems()
        // Use setTimeout to avoid ExpressionChangedAfterItHasBeenCheckedError
        window.setTimeout(() => {
            this.cdr.markForCheck()
        }, 0)
        // Helpful UX feedback (also acts as a sanity check that click handlers are firing)
        try {
            const nowExpanded = !wasExpanded
            this.statusMessage = `${nowExpanded ? 'Expanded' : 'Collapsed'}: ${node.name}`
            window.setTimeout(() => {
                if (this.statusMessage === `${nowExpanded ? 'Expanded' : 'Collapsed'}: ${node.name}`) {
                    this.statusMessage = ''
                }
            }, 1200)
        } catch {
            // ignore
        }
    }

    async onTreeClick (event: MouseEvent, node: TreeNode): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        this.treeKeyboardActive = true
        const isMultiSelect = event.metaKey || event.ctrlKey
        // Don't toggle if clicking on chevron (chevron has its own handler)
        if ((event?.target as any)?.classList?.contains('chevron')) {
            return
        }
        if (node.isFolder) {
            if (event.shiftKey) {
                if (node.path) {
                    this.extendFolderSelection(node.path)
                }
                this.selectFolder(node.path || null, false)
                return
            }
            if (isMultiSelect) {
                if (node.path) {
                    this.toggleFolderSelection(node.path)
                }
                this.selectFolder(node.path || null, false)
                return
            }
            this.selectFolder(node.path || null)
            this.toggleFolder(event, node)
            return
        }

        if (node.docId) {
            if (node.path) {
                if (event.shiftKey) {
                    this.extendFileSelection(node.path)
                } else if (isMultiSelect) {
                    this.toggleFileSelection(node.path)
                } else {
                    this.setFileSelection([node.path])
                }
                this.selectedFolderPathKeys = new Set()
                this.folderSelectionAnchorKey = null
            } else {
                this.selectedFilePathKeys = new Set()
                this.fileSelectionAnchorKey = null
                if (!isMultiSelect) {
                    this.selectedFolderPathKeys = new Set()
                    this.folderSelectionAnchorKey = null
                }
            }
            this.activateDoc(node.docId, !(event.shiftKey || isMultiSelect))
            return
        }

        const filePath = node.path
        if (!filePath) {
            this.selectedFilePathKeys = new Set()
            this.fileSelectionAnchorKey = null
            if (node.docId) {
                this.activateDoc(node.docId)
            }
            return
        }
        try {
            const stat = fsSync.statSync(filePath)
            if (!stat.isFile()) {
                return
            }
        } catch {
            return
        }

        if (event.shiftKey) {
            this.extendFileSelection(filePath)
        } else if (isMultiSelect) {
            this.toggleFileSelection(filePath)
        } else {
            this.setFileSelection([filePath])
        }
        this.selectedFolderPathKeys = new Set()
        this.folderSelectionAnchorKey = null
        await this.openFileFromDiskPath(filePath, !(event.shiftKey || isMultiSelect))
    }

    onTreeDblClick (event: MouseEvent, node: TreeNode): void {
        if (node.isFolder) {
            event.stopPropagation()
            this.toggleFolder(event, node)
            return
        }
        if (!node.isFolder && node.docId) {
            this.startInlineRename(event, node.docId)
        }
    }

    onTreeContextMenu (event: MouseEvent, node: TreeNode): void {
        event.preventDefault()
        event.stopPropagation()
        this.treeKeyboardActive = true
        if (node.isFolder) {
            this.selectFoldersForContextMenu(node.path)
            this.openFolderContextMenu(event, node.path)
        } else if (node.docId) {
            const doc = this.documents.find(d => d.id === node.docId)
            if (doc && !doc.path) {
                // Unsaved docs may have a temp backing file in the tree; use doc actions.
                this.openDocContextMenu(event, node.docId)
                return
            }
            if (node.path) {
                this.selectFilesForContextMenu(node.path)
                this.openFileContextMenu(event, node.path)
                return
            }
            this.openDocContextMenu(event, node.docId)
        } else if (node.path) {
            // File nodes with no linked open doc.
            this.selectFilesForContextMenu(node.path)
            this.openFileContextMenu(event, node.path)
        }
    }

    private async moveDocumentToFolder (docId: string, folderPath: string|null): Promise<void> {
        const doc = this.documents.find(d => d.id === docId)
        if (!doc) {
            return
        }
        const currentFolder = this.resolveDocFolder(doc)
        const targetFolder = folderPath || null
        const targetDir = targetFolder ?? this.folderRoot
        const currentLocation = doc.path
            ? path.dirname(path.resolve(doc.path))
            : (doc.tempPath ? path.dirname(path.resolve(doc.tempPath)) : (currentFolder ? path.resolve(currentFolder) : null))
        if (currentLocation && path.resolve(targetDir) === currentLocation) {
            return
        }
        if (!fsSync.existsSync(targetDir)) {
            try {
                fsSync.mkdirSync(targetDir, { recursive: true })
            } catch {
                this.setError('Cannot create target folder')
                return
            }
        }
        const targetName = doc.name || path.basename(doc.path ?? doc.tempPath ?? 'untitled')
        const targetPath = await this.ensureUniquePath(targetDir, targetName)

        if (doc.path) {
            // If the document is outside managed folders and the target is "all documents", just drop the association.
            if (!currentFolder && !targetFolder) {
                doc.folderPath = null
                this.updateTreeItems()
                window.setTimeout(() => this.cdr.markForCheck(), 0)
                this.persistState()
                return
            }
            try {
                await fs.mkdir(path.dirname(targetPath), { recursive: true })
                await fs.rename(doc.path, targetPath)
                doc.path = targetPath
                doc.name = path.basename(targetPath)
                doc.folderPath = targetFolder
                this.setModelLanguage(doc)
            } catch (err: any) {
                this.setError(`Move failed: ${err?.message ?? err}`)
                return
            }
        } else {
            const oldTemp = doc.tempPath
            doc.folderPath = targetFolder
            doc.tempPath = this.allocateTempPath(doc.name || 'untitled', targetFolder)
            this.revealTreePath(doc.tempPath)
            if (oldTemp && fsSync.existsSync(oldTemp)) {
                try {
                    await fs.mkdir(path.dirname(doc.tempPath), { recursive: true })
                    await fs.rename(oldTemp, doc.tempPath)
                } catch {
                    // best effort
                }
            }
        }
        this.syncOpenedFileScopes()
        this.updateTreeItems()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
        this.persistState()
    }

    private async ensureUniquePath (dir: string, name: string): Promise<string> {
        const ext = path.extname(name)
        const base = path.basename(name, ext)
        let candidate = path.join(dir, name)
        let i = 1
        while (fsSync.existsSync(candidate)) {
            candidate = path.join(dir, `${base}-${i}${ext}`)
            i++
        }
        return candidate
    }

    private async createSimpleFileOnDisk (
        nameHint: string,
        content: string,
        preferredFolder?: string|null,
    ): Promise<string> {
        const targetFolder = this.resolveFolderCreationParent(preferredFolder ?? this.selectedFolderPath ?? this.folderRoot)
        let targetName = (nameHint ?? '').trim()
        if (!targetName || /[\\/]/.test(targetName)) {
            targetName = this.nextUntitledName(targetFolder)
        }
        let targetPath = path.join(targetFolder, targetName)
        if (fsSync.existsSync(targetPath)) {
            targetPath = await this.ensureUniquePath(targetFolder, targetName)
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        await fs.writeFile(targetPath, content, 'utf8')
        return targetPath
    }

    constructor (
        private injector: Injector,
        private platform: PlatformService,
        private app: AppService,
        private tabsService: TabsService,
        @Optional() private ngbModal: NgbModal,
        private cdr: ChangeDetectorRef,
    ) {
        super(injector)
        this.setTitle(this.studioTitle)
    }

    get visibleDocuments (): EditorDocument[] {
        if (!this.selectedFolderPath) {
            return this.documents
        }
        return this.documents.filter(doc => this.resolveDocFolder(doc) === this.selectedFolderPath)
    }

    get treeItems (): Array<{ node: TreeNode, depth: number }> {
        return this._treeItems
    }

    get visibleTreeItems (): Array<{ node: TreeNode, depth: number }> {
        return this._visibleTreeItems
    }

    get canShowTopologyToggle (): boolean {
        const doc = this.getActiveDoc()
        return !!doc && this.isTopologyDocCandidate(doc)
    }

    get topologyNodes (): TopologyNodeModel[] {
        return this.topologyData?.nodes ?? []
    }

    get topologyLinks (): TopologyLinkModel[] {
        return this.topologyData?.links ?? []
    }

    get topologyShapes (): TopologyShapeModel[] {
        return this.topologyData?.shapes ?? []
    }

    get topologyTexts (): TopologyTextModel[] {
        return this.topologyData?.texts ?? []
    }

    get selectedTopologyNode (): TopologyNodeModel|null {
        if (!this.topologyData || !this.topologySelectedNodeId) {
            return null
        }
        return this.topologyData.nodes.find(n => n.id === this.topologySelectedNodeId) ?? null
    }

    get selectedTopologyLink (): TopologyLinkModel|null {
        if (!this.topologyData || !this.topologySelectedLinkId) {
            return null
        }
        return this.topologyData.links.find(l => l.id === this.topologySelectedLinkId) ?? null
    }

    get selectedTopologyShape (): TopologyShapeModel|null {
        if (!this.topologyData || !this.topologySelectedShapeId) {
            return null
        }
        return this.topologyData.shapes.find(s => s.id === this.topologySelectedShapeId) ?? null
    }

    get selectedTopologyText (): TopologyTextModel|null {
        if (!this.topologyData || !this.topologySelectedTextId) {
            return null
        }
        return this.topologyData.texts.find(t => t.id === this.topologySelectedTextId) ?? null
    }

    get selectedTopologyNodeColor (): string {
        return this.normalizeTopologyHexColor(this.selectedTopologyNode?.color) ?? this.getTopologyDefaultNodeColor()
    }

    get selectedTopologyLinkColor (): string {
        return this.normalizeTopologyHexColor(this.selectedTopologyLink?.color) ?? this.getTopologyDefaultLinkColor()
    }

    get selectedTopologyShapeColor (): string {
        return this.normalizeTopologyHexColor(this.selectedTopologyShape?.color) ?? this.getTopologyDefaultShapeColor()
    }

    get selectedTopologyTextColor (): string {
        const selected = this.selectedTopologyText
        if (!selected) {
            return this.getTopologyDefaultTextColor()
        }
        if (selected.sticky) {
            return this.normalizeTopologyHexColor(selected.color) ?? this.getTopologyDefaultStickyNoteColor()
        }
        return this.normalizeTopologyHexColor(selected.color) ?? this.getTopologyDefaultTextColor()
    }

    get selectedTopologyNodeCount (): number {
        return this.topologySelectedNodeIds.size
    }

    get selectedTopologyLinkCount (): number {
        return this.topologySelectedLinkIds.size
    }

    get selectedTopologyShapeCount (): number {
        return this.topologySelectedShapeIds.size
    }

    get selectedTopologyNodesColorValue (): string {
        return this.getTopologySelectionColorValue('node')
    }

    get selectedTopologyLinksColorValue (): string {
        return this.getTopologySelectionColorValue('link')
    }

    get selectedTopologyShapesColorValue (): string {
        return this.getTopologySelectionColorValue('shape')
    }

    get selectedTopologyLinksDirectionValue (): string {
        if (!this.topologyData) {
            return ''
        }
        if (!this.topologySelectedLinkIds.size) {
            if (!this.selectedTopologyLink) {
                return ''
            }
            return this.getTopologyLinkStyle(this.selectedTopologyLink)
        }
        const values = new Set<string>()
        for (const link of this.topologyData.links) {
            if (!this.topologySelectedLinkIds.has(link.id)) {
                continue
            }
            values.add(this.getTopologyLinkStyle(link))
        }
        if (values.size === 1) {
            return values.values().next().value ?? ''
        }
        return ''
    }

    get hasTopologyLinkSelection (): boolean {
        return this.topologySelectedLinkIds.size > 0 || !!this.selectedTopologyLink
    }

    get topologyLinkStyleToggleState (): TopologyLinkStyle {
        if (this.hasTopologyLinkSelection) {
            const selectedStyle = this.selectedTopologyLinksDirectionValue
            if (selectedStyle === 'line' || selectedStyle === 'arrow' || selectedStyle === 'double') {
                return selectedStyle
            }
            return 'line'
        }
        return this.topologyNewLinksDirected ? 'arrow' : 'line'
    }

    get topologyLinkStyleToggleTooltip (): string {
        if (this.hasTopologyLinkSelection) {
            const label = this.topologyLinkStyleToggleState === 'double'
                ? 'double-arrow'
                : this.topologyLinkStyleToggleState
            return `Selected links: ${label} (click to cycle line/arrow/double-arrow)`
        }
        return this.topologyNewLinksDirected
            ? 'New node links use arrows'
            : 'New node links use straight lines'
    }

    get topologyNodeColorOptions (): TopologyColorOption[] {
        return this.getTopologyColorOptions(this.selectedTopologyNodesColorValue || this.getTopologyDefaultNodeColor())
    }

    get topologyLinkColorOptions (): TopologyColorOption[] {
        return this.getTopologyColorOptions(this.selectedTopologyLinksColorValue || this.getTopologyDefaultLinkColor())
    }

    get topologyShapeColorOptions (): TopologyColorOption[] {
        return this.getTopologyColorOptions(this.selectedTopologyShapesColorValue || this.getTopologyDefaultShapeColor())
    }

    get topologyTextColorOptions (): TopologyColorOption[] {
        if (this.selectedTopologyText?.sticky) {
            return this.getTopologyColorOptions(this.selectedTopologyTextColor, this.topologyStickyColorPalette)
        }
        return this.getTopologyColorOptions(this.selectedTopologyTextColor)
    }

    get canDeleteSelectedTopology (): boolean {
        return this.topologySelectedNodeIds.size > 0 ||
            this.topologySelectedLinkIds.size > 0 ||
            this.topologySelectedShapeIds.size > 0 ||
            this.topologySelectedTextIds.size > 0 ||
            !!this.selectedTopologyNode ||
            !!this.selectedTopologyLink ||
            !!this.selectedTopologyShape ||
            !!this.selectedTopologyText
    }

    get hasTopologySelection (): boolean {
        return this.topologySelectedNodeIds.size > 0 ||
            this.topologySelectedLinkIds.size > 0 ||
            this.topologySelectedShapeIds.size > 0 ||
            this.topologySelectedTextIds.size > 0
    }

    get canUndoTopology (): boolean {
        return this.topologyUndoStack.length > 0
    }

    get canRedoTopology (): boolean {
        return this.topologyRedoStack.length > 0
    }

    get canRestoreTopologySnapshot (): boolean {
        const doc = this.getActiveDoc()
        if (!doc) {
            return false
        }
        const points = this.topologyRestorePointsByDoc.get(doc.id) ?? []
        return points.length > 1
    }

    get topologyCanvasTransform (): string {
        return `translate(${this.topologyPanX}px, ${this.topologyPanY}px) scale(${this.topologyZoom})`
    }

    get topologyZoomLabel (): string {
        return `${Math.round(this.topologyZoom * 100)}%`
    }

    get canAlignTopologyNodes (): boolean {
        return this.getSelectedTopologyLayoutItems().length >= 2
    }

    get canDistributeTopologyNodes (): boolean {
        return this.getSelectedTopologyLayoutItems().length >= 3
    }

    get topologyFreeLinkPreviewPath (): string|null {
        if (!this.topologyPendingFreeLinkStart || !this.topologyFreeLinkDraftEnd) {
            return null
        }
        return `M ${this.topologyPendingFreeLinkStart.x} ${this.topologyPendingFreeLinkStart.y} L ${this.topologyFreeLinkDraftEnd.x} ${this.topologyFreeLinkDraftEnd.y}`
    }

    get topologyLinkRenderItems (): TopologyLinkRenderItem[] {
        if (!this.topologyLinkRenderItemsDirty) {
            return this.topologyLinkRenderItemsCache
        }
        this.topologyLinkRenderItemsCache = this.buildTopologyLinkRenderItems()
        this.topologyLinkRenderItemsDirty = false
        return this.topologyLinkRenderItemsCache
    }

    private buildTopologyLinkRenderItems (): TopologyLinkRenderItem[] {
        if (!this.topologyData) {
            this.topologyLinkRenderItemsCache = []
            return []
        }
        const nodeById = new Map<string, TopologyNodeModel>()
        for (const node of this.topologyData.nodes) {
            nodeById.set(node.id, node)
        }
        const shapeById = new Map<string, TopologyShapeModel>()
        for (const shape of this.topologyData.shapes) {
            shapeById.set(shape.id, shape)
        }
        const groupedNodeLinkIds = new Map<string, string[]>()
        for (const link of this.topologyData.links) {
            if (!link.from || !link.to) {
                continue
            }
            const fromKind = this.resolveTopologyLinkEndpointKind(link.fromKind, link.from, nodeById, shapeById)
            const toKind = this.resolveTopologyLinkEndpointKind(link.toKind, link.to, nodeById, shapeById)
            if (!fromKind || !toKind) {
                continue
            }
            const key = [`${fromKind}:${link.from}`, `${toKind}:${link.to}`].sort().join('::')
            const group = groupedNodeLinkIds.get(key) ?? []
            group.push(link.id)
            groupedNodeLinkIds.set(key, group)
        }
        const linkLaneOffsetById = new Map<string, number>()
        for (const group of groupedNodeLinkIds.values()) {
            const ordered = [...group].sort()
            const mid = (ordered.length - 1) / 2
            for (let i = 0; i < ordered.length; i++) {
                linkLaneOffsetById.set(ordered[i], i - mid)
            }
        }
        const items: TopologyLinkRenderItem[] = []
        for (const link of this.topologyData.links) {
            let fromPoint: { x: number, y: number }|null = null
            let toPoint: { x: number, y: number }|null = null
            let laneOffset = 0
            const fromId = link.from?.trim()
            const toId = link.to?.trim()
            const fromKind = this.resolveTopologyLinkEndpointKind(link.fromKind, fromId, nodeById, shapeById)
            const toKind = this.resolveTopologyLinkEndpointKind(link.toKind, toId, nodeById, shapeById)
            if (fromId && toId && fromKind && toKind) {
                const fromNode = fromKind === 'node' ? nodeById.get(fromId) : undefined
                const toNode = toKind === 'node' ? nodeById.get(toId) : undefined
                const fromShape = fromKind === 'shape' ? shapeById.get(fromId) : undefined
                const toShape = toKind === 'shape' ? shapeById.get(toId) : undefined
                if (
                    (fromKind === 'node' && !fromNode) ||
                    (fromKind === 'shape' && !fromShape) ||
                    (toKind === 'node' && !toNode) ||
                    (toKind === 'shape' && !toShape)
                ) {
                    continue
                }
                const fromCenter = fromKind === 'node'
                    ? this.getTopologyNodeCenter(fromNode!)
                    : this.getTopologyShapeCenter(fromShape!)
                const toCenter = toKind === 'node'
                    ? this.getTopologyNodeCenter(toNode!)
                    : this.getTopologyShapeCenter(toShape!)
                const fromCx = fromCenter.x
                const fromCy = fromCenter.y
                const toCx = toCenter.x
                const toCy = toCenter.y
                if (Math.abs(toCx - fromCx) < 0.01 && Math.abs(toCy - fromCy) < 0.01) {
                    continue
                }
                fromPoint = fromKind === 'node'
                    ? this.getTopologyNodeEdgePoint(fromNode!, toCx, toCy, 3)
                    : this.getTopologyShapeEdgePoint(fromShape!, toCx, toCy, 3)
                toPoint = toKind === 'node'
                    ? this.getTopologyNodeEdgePoint(toNode!, fromCx, fromCy, 3)
                    : this.getTopologyShapeEdgePoint(toShape!, fromCx, fromCy, 3)
                laneOffset = linkLaneOffsetById.get(link.id) ?? 0
            } else {
                const x1 = Number(link.x1)
                const y1 = Number(link.y1)
                const x2 = Number(link.x2)
                const y2 = Number(link.y2)
                if (![x1, y1, x2, y2].every(Number.isFinite)) {
                    continue
                }
                if (Math.abs(x2 - x1) < 0.01 && Math.abs(y2 - y1) < 0.01) {
                    continue
                }
                fromPoint = { x: x1, y: y1 }
                toPoint = { x: x2, y: y2 }
            }
            if (!fromPoint || !toPoint) {
                continue
            }
            const dx = toPoint.x - fromPoint.x
            const dy = toPoint.y - fromPoint.y
            const len = Math.hypot(dx, dy) || 1
            const dirX = dx / len
            const dirY = dy / len
            const normalX = -dirY
            const normalY = dirX
            let fromDrawX = fromPoint.x
            let fromDrawY = fromPoint.y
            let toDrawX = toPoint.x
            let toDrawY = toPoint.y
            if (!this.topologyCurvedLinks && laneOffset !== 0) {
                const straightShift = laneOffset * 9
                fromDrawX += normalX * straightShift
                fromDrawY += normalY * straightShift
                toDrawX += normalX * straightShift
                toDrawY += normalY * straightShift
            }
            let pathDef = `M ${fromDrawX} ${fromDrawY} L ${toDrawX} ${toDrawY}`
            let labelX = (fromDrawX + toDrawX) / 2
            let labelY = (fromDrawY + toDrawY) / 2
            if (this.topologyCurvedLinks) {
                const bendBase = Math.min(56, len * 0.22)
                const bend = bendBase + laneOffset * 18
                const cx = (fromDrawX + toDrawX) / 2 + normalX * bend
                const cy = (fromDrawY + toDrawY) / 2 + normalY * bend
                pathDef = `M ${fromDrawX} ${fromDrawY} Q ${cx} ${cy} ${toDrawX} ${toDrawY}`
                labelX = 0.25 * fromDrawX + 0.5 * cx + 0.25 * toDrawX
                labelY = 0.25 * fromDrawY + 0.5 * cy + 0.25 * toDrawY
            }
            const baseLabelX = labelX
            const baseLabelY = labelY
            let renderLabels: TopologyLinkLabelModel[]|null = Array.isArray(link.labels) ? link.labels : null
            if (!renderLabels || (!renderLabels.length && (link.label || link.labelOffsetX != null || link.labelOffsetY != null))) {
                renderLabels = this.getTopologyLinkLabels(link)
            }
            const seenLabelIds = new Set<string>()
            const labels = (renderLabels ?? [])
                .filter((label): label is TopologyLinkLabelModel => {
                    if (!label || typeof label.id !== 'string') {
                        return false
                    }
                    if (seenLabelIds.has(label.id)) {
                        return false
                    }
                    seenLabelIds.add(label.id)
                    return true
                })
                .map(label => {
                const hasLocalOffsets = Number.isFinite(Number(label.offsetAlong)) || Number.isFinite(Number(label.offsetNormal))
                const local = this.getTopologyLinkLabelLocalOffsets(label, dirX, dirY, normalX, normalY)
                if (!hasLocalOffsets && (Number.isFinite(Number(label.offsetX)) || Number.isFinite(Number(label.offsetY)))) {
                    label.offsetAlong = Number(local.along.toFixed(2))
                    label.offsetNormal = Number(local.normal.toFixed(2))
                }
                const offsetX = local.along * dirX + local.normal * normalX
                const offsetY = local.along * dirY + local.normal * normalY
                return {
                    id: label.id,
                    text: label.text ?? '',
                    labelX: baseLabelX + offsetX,
                    labelY: baseLabelY + offsetY,
                    baseLabelX,
                    baseLabelY,
                }
                })
            const style = this.getTopologyLinkStyle(link)
            items.push({
                id: link.id,
                path: pathDef,
                labels,
                baseLabelX,
                baseLabelY,
                dirX,
                dirY,
                normalX,
                normalY,
                startX: fromDrawX,
                startY: fromDrawY,
                endX: toDrawX,
                endY: toDrawY,
                isFree: !fromId || !toId || !fromKind || !toKind,
                color: this.normalizeTopologyHexColor(link.color) ?? this.getTopologyDefaultLinkColor(),
                directed: style !== 'line',
                bidirectional: style === 'double',
            })
        }
        return items
    }

    trackTopologyNode (_index: number, node: TopologyNodeModel): string {
        return node.id
    }

    trackTopologyShape (_index: number, item: TopologyShapeModel): string {
        return item.id
    }

    trackTopologyText (_index: number, item: TopologyTextModel): string {
        return item.id
    }

    trackTopologyLinkRender (_index: number, link: { id: string }): string {
        return link.id
    }

    trackTopologyLinkRenderLabel (_index: number, label: { id: string }): string {
        return label.id
    }

    isTopologyNodeSelected (nodeId: string): boolean {
        return this.topologySelectedNodeIds.has(nodeId)
    }

    getTopologyNodeWidth (node: TopologyNodeModel): number {
        return this.getTopologyNodeSize(node).width
    }

    getTopologyNodeHeight (node: TopologyNodeModel): number {
        return this.getTopologyNodeSize(node).height
    }

    getTopologyNodeIconKind (node: TopologyNodeModel): 'router'|'switch'|'host'|'default' {
        const type = String(node?.type ?? '').toLowerCase().trim()
        if (type === 'router') {
            return 'router'
        }
        if (type === 'switch') {
            return 'switch'
        }
        if (type === 'host') {
            return 'host'
        }
        return 'default'
    }

    isTopologyLinkSelected (linkId: string): boolean {
        return this.topologySelectedLinkIds.has(linkId)
    }

    isTopologyShapeSelected (shapeId: string): boolean {
        return this.topologySelectedShapeIds.has(shapeId)
    }

    isTopologyTextSelected (textId: string): boolean {
        return this.topologySelectedTextIds.has(textId)
    }

    getTopologyTextDisplayColor (item: TopologyTextModel): string|null {
        if (!item.sticky) {
            return this.normalizeTopologyHexColor(item.color) ?? this.getTopologyDefaultTextColor()
        }
        return this.getTopologyStickyNoteTextColor(item)
    }

    getTopologyStickyNoteBackgroundColor (item: TopologyTextModel): string|null {
        if (!item.sticky) {
            return null
        }
        return this.normalizeTopologyHexColor(item.color) ?? this.getTopologyDefaultStickyNoteColor()
    }

    getTopologyStickyNoteTextColor (item: TopologyTextModel): string {
        const background = this.normalizeTopologyHexColor(item.color) ?? this.getTopologyDefaultStickyNoteColor()
        return this.getTopologyReadableTextColor(background, '#2f2611', '#f8fafc')
    }

    getTopologyTextWidth (item: TopologyTextModel): number|null {
        if (!item.sticky) {
            return null
        }
        const widthRaw = Number(item.width)
        if (!Number.isFinite(widthRaw)) {
            return null
        }
        return Math.max(100, widthRaw)
    }

    getTopologyTextHeight (item: TopologyTextModel): number|null {
        if (!item.sticky) {
            return null
        }
        if (item.collapsed) {
            return this.topologyStickyCollapsedHeightPx
        }
        const widthRaw = Number(item.width)
        const width = Number.isFinite(widthRaw) ? Math.max(100, widthRaw) : 176
        const autoHeight = this.getTopologyStickyContentHeight(item.text, width)
        const heightRaw = Number(item.height)
        if (!Number.isFinite(heightRaw)) {
            return autoHeight
        }
        return Math.max(autoHeight, Math.max(64, heightRaw))
    }

    isTopologyStickyCollapsed (item: TopologyTextModel): boolean {
        return item.sticky === true && item.collapsed === true
    }

    getTopologyStickyCollapsedLabel (item: TopologyTextModel): string {
        if (!item.sticky) {
            return item.text || 'Text'
        }
        const texts = this.topologyData?.texts ?? []
        let stickyOrdinal = 0
        for (const entry of texts) {
            if (!entry.sticky) {
                continue
            }
            stickyOrdinal += 1
            if (entry.id === item.id) {
                return `Sticky ${stickyOrdinal}`
            }
        }
        const fallback = String(item.id ?? '').match(/(\d+)(?!.*\d)/)?.[1]
        return fallback ? `Sticky ${fallback}` : 'Sticky'
    }

    private getSelectedTopologyLayoutItems (): Array<{ item: TopologyNodeModel|TopologyShapeModel, width: number, height: number }> {
        if (!this.topologyData) {
            return []
        }
        const items: Array<{ item: TopologyNodeModel|TopologyShapeModel, width: number, height: number }> = []

        const selectedNodeIds = this.topologySelectedNodeIds.size
            ? this.topologySelectedNodeIds
            : (this.selectedTopologyNode ? new Set([this.selectedTopologyNode.id]) : new Set<string>())
        for (const node of this.topologyData.nodes) {
            if (!selectedNodeIds.has(node.id)) {
                continue
            }
            items.push({
                item: node,
                width: this.getTopologyNodeWidth(node),
                height: this.getTopologyNodeHeight(node),
            })
        }

        const selectedShapeIds = this.topologySelectedShapeIds.size
            ? this.topologySelectedShapeIds
            : (this.selectedTopologyShape ? new Set([this.selectedTopologyShape.id]) : new Set<string>())
        for (const shape of this.topologyData.shapes) {
            if (!selectedShapeIds.has(shape.id)) {
                continue
            }
            items.push({
                item: shape,
                width: shape.width,
                height: shape.height,
            })
        }

        return items
    }

    private clearTopologySelection (): void {
        this.clearTopologyInlineEditState()
        this.topologySelectedNodeIds.clear()
        this.topologySelectedLinkIds.clear()
        this.topologySelectedShapeIds.clear()
        this.topologySelectedTextIds.clear()
        this.topologySelectedNodeId = null
        this.topologySelectedLinkId = null
        this.topologySelectedShapeId = null
        this.topologySelectedTextId = null
    }

    private syncTopologyPrimarySelectionFromSets (): void {
        const nodeCount = this.topologySelectedNodeIds.size
        const linkCount = this.topologySelectedLinkIds.size
        const shapeCount = this.topologySelectedShapeIds.size
        const textCount = this.topologySelectedTextIds.size
        const total = nodeCount + linkCount + shapeCount + textCount
        this.topologySelectedNodeId = null
        this.topologySelectedLinkId = null
        this.topologySelectedShapeId = null
        this.topologySelectedTextId = null
        if (total !== 1) {
            return
        }
        if (nodeCount === 1) {
            this.topologySelectedNodeId = this.topologySelectedNodeIds.values().next().value ?? null
            return
        }
        if (linkCount === 1) {
            this.topologySelectedLinkId = this.topologySelectedLinkIds.values().next().value ?? null
            return
        }
        if (shapeCount === 1) {
            this.topologySelectedShapeId = this.topologySelectedShapeIds.values().next().value ?? null
            return
        }
        this.topologySelectedTextId = this.topologySelectedTextIds.values().next().value ?? null
    }

    private setTopologySingleSelection (kind: 'node'|'link'|'shape'|'text', id: string): void {
        this.clearTopologySelection()
        if (kind === 'node') {
            this.topologySelectedNodeIds.add(id)
        } else if (kind === 'link') {
            this.topologySelectedLinkIds.add(id)
        } else if (kind === 'shape') {
            this.topologySelectedShapeIds.add(id)
        } else {
            this.topologySelectedTextIds.add(id)
        }
        this.syncTopologyPrimarySelectionFromSets()
    }

    private toggleTopologySelection (kind: 'node'|'link'|'shape'|'text', id: string): void {
        if (kind === 'node') {
            if (this.topologySelectedNodeIds.has(id)) {
                this.topologySelectedNodeIds.delete(id)
            } else {
                this.topologySelectedNodeIds.add(id)
            }
        } else if (kind === 'link') {
            if (this.topologySelectedLinkIds.has(id)) {
                this.topologySelectedLinkIds.delete(id)
            } else {
                this.topologySelectedLinkIds.add(id)
            }
        } else if (kind === 'shape') {
            if (this.topologySelectedShapeIds.has(id)) {
                this.topologySelectedShapeIds.delete(id)
            } else {
                this.topologySelectedShapeIds.add(id)
            }
        } else {
            if (this.topologySelectedTextIds.has(id)) {
                this.topologySelectedTextIds.delete(id)
            } else {
                this.topologySelectedTextIds.add(id)
            }
        }
        this.syncTopologyPrimarySelectionFromSets()
    }

    private hasTopologyInlineEdit (): boolean {
        return !!this.topologyInlineEditNodeId || !!this.topologyInlineEditLinkId || !!this.topologyInlineEditShapeId || !!this.topologyInlineEditTextId
    }

    isTopologyInlineEditingNode (id: string): boolean {
        return this.topologyInlineEditNodeId === id
    }

    isTopologyInlineEditingLink (id: string, labelId?: string|null): boolean {
        if (this.topologyInlineEditLinkId !== id) {
            return false
        }
        if (labelId == null) {
            return true
        }
        return this.topologyInlineEditLinkLabelId === labelId
    }

    getTopologyInlineEditorXForLink (item: TopologyLinkRenderItem, labelId?: string|null): number {
        const targetLabel = labelId
            ? item.labels.find(label => label.id === labelId)
            : item.labels[0]
        if (this.topologyInlineEditLinkId === item.id && this.topologyInlineEditLinkX != null) {
            return this.topologyInlineEditLinkX
        }
        return targetLabel?.labelX ?? 0
    }

    getTopologyInlineEditorYForLink (item: TopologyLinkRenderItem, labelId?: string|null): number {
        const targetLabel = labelId
            ? item.labels.find(label => label.id === labelId)
            : item.labels[0]
        if (this.topologyInlineEditLinkId === item.id && this.topologyInlineEditLinkY != null) {
            return this.topologyInlineEditLinkY
        }
        return targetLabel?.labelY ?? 0
    }

    isTopologyInlineEditingShape (id: string): boolean {
        return this.topologyInlineEditShapeId === id
    }

    isTopologyInlineEditingText (id: string): boolean {
        return this.topologyInlineEditTextId === id
    }

    getTopologyInlineTextInputWidthPx (): number {
        const value = this.topologyInlineEditValue ?? ''
        const sample = value.length ? value : 'Text'
        const next = Math.ceil(sample.length * 8.2) + 24
        return Math.max(120, Math.min(640, next))
    }

    onTopologyInlineEditInput (value: string): void {
        this.topologyInlineEditValue = value
        this.cdr.markForCheck()
    }

    onTopologyInlineEditKeydown (event: KeyboardEvent, multiline = false): void {
        if (event.key === 'Enter') {
            if (multiline && !event.ctrlKey && !event.metaKey) {
                return
            }
            event.preventDefault()
            event.stopPropagation()
            this.commitTopologyInlineEdit()
            return
        }
        if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            this.cancelTopologyInlineEdit()
        }
    }

    onTopologyInlineEditBlur (): void {
        this.commitTopologyInlineEdit()
    }

    private clearTopologyInlineEditState (markForCheck = false): void {
        this.topologyInlineEditNodeId = null
        this.topologyInlineEditLinkId = null
        this.topologyInlineEditLinkLabelId = null
        this.topologyInlineEditLinkX = null
        this.topologyInlineEditLinkY = null
        this.topologyInlineEditShapeId = null
        this.topologyInlineEditTextId = null
        this.topologyInlineEditValue = ''
        if (markForCheck) {
            this.cdr.markForCheck()
        }
    }

    private beginTopologyInlineEdit (
        kind: TopologyInlineEditKind,
        id: string,
        initialValue: string,
        anchorX?: number|null,
        anchorY?: number|null,
        linkLabelId?: string|null,
    ): void {
        const sameTarget =
            (kind === 'node' && this.topologyInlineEditNodeId === id) ||
            (kind === 'link' && this.topologyInlineEditLinkId === id && this.topologyInlineEditLinkLabelId === (linkLabelId ?? null)) ||
            (kind === 'shape' && this.topologyInlineEditShapeId === id) ||
            (kind === 'text' && this.topologyInlineEditTextId === id)
        if (sameTarget) {
            if (kind === 'link' && Number.isFinite(Number(anchorX)) && Number.isFinite(Number(anchorY))) {
                this.topologyInlineEditLinkX = Number(anchorX)
                this.topologyInlineEditLinkY = Number(anchorY)
            }
            this.cdr.markForCheck()
            window.setTimeout(() => this.focusTopologyInlineEditInput(kind, id), 0)
            return
        }
        this.topologyInlineEditNodeId = null
        this.topologyInlineEditLinkId = null
        this.topologyInlineEditLinkLabelId = null
        this.topologyInlineEditLinkX = null
        this.topologyInlineEditLinkY = null
        this.topologyInlineEditShapeId = null
        this.topologyInlineEditTextId = null
        if (kind === 'node') {
            this.topologyInlineEditNodeId = id
        } else if (kind === 'link') {
            this.topologyInlineEditLinkId = id
            this.topologyInlineEditLinkLabelId = linkLabelId ?? null
            if (Number.isFinite(Number(anchorX)) && Number.isFinite(Number(anchorY))) {
                this.topologyInlineEditLinkX = Number(anchorX)
                this.topologyInlineEditLinkY = Number(anchorY)
            }
        } else if (kind === 'shape') {
            this.topologyInlineEditShapeId = id
        } else {
            this.topologyInlineEditTextId = id
        }
        this.topologyInlineEditValue = initialValue
        this.cdr.markForCheck()
        window.setTimeout(() => this.focusTopologyInlineEditInput(kind, id), 0)
    }

    private focusTopologyInlineEditInput (kind: TopologyInlineEditKind, id: string): void {
        const canvas = this.topologyCanvas?.nativeElement
        if (!canvas) {
            return
        }
        const primarySelector = kind === 'link' && this.topologyInlineEditLinkLabelId
            ? `.topology-inline-input[data-inline-kind="${kind}"][data-inline-id="${id}"][data-inline-label-id="${this.topologyInlineEditLinkLabelId}"]`
            : `.topology-inline-input[data-inline-kind="${kind}"][data-inline-id="${id}"]`
        let input = canvas.querySelector(primarySelector) as HTMLInputElement | HTMLTextAreaElement | null
        if (!input && kind === 'link') {
            const fallbackSelector = `.topology-inline-input[data-inline-kind="${kind}"][data-inline-id="${id}"]`
            input = canvas.querySelector(fallbackSelector) as HTMLInputElement | HTMLTextAreaElement | null
        }
        if (!input) {
            return
        }
        input.focus()
        if (typeof input.select === 'function') {
            input.select()
        }
    }

    private commitTopologyInlineEdit (): void {
        if (!this.topologyData || !this.hasTopologyInlineEdit()) {
            return
        }
        const value = this.topologyInlineEditValue
        let changed = false
        if (this.topologyInlineEditNodeId) {
            const node = this.topologyData.nodes.find(x => x.id === this.topologyInlineEditNodeId)
            if (node && node.label !== value) {
                node.label = value
                changed = true
            }
        } else if (this.topologyInlineEditLinkId) {
            const link = this.topologyData.links.find(x => x.id === this.topologyInlineEditLinkId)
            if (link && this.topologyInlineEditLinkLabelId) {
                const labels = this.getTopologyLinkLabels(link)
                const labelIndex = labels.findIndex(item => item.id === this.topologyInlineEditLinkLabelId)
                if (labelIndex >= 0) {
                    const nextText = String(value ?? '')
                    if (nextText) {
                        if (labels[labelIndex].text !== nextText) {
                            labels[labelIndex].text = nextText
                            changed = true
                        }
                    } else {
                        labels.splice(labelIndex, 1)
                        changed = true
                    }
                }
                if (this.topologyInlineEditLinkX != null && this.topologyInlineEditLinkY != null) {
                    const renderItem = this.topologyLinkRenderItems.find(item => item.id === link.id)
                    const renderLabel = renderItem?.labels.find(item => item.id === this.topologyInlineEditLinkLabelId)
                    if (renderItem && renderLabel && labelIndex >= 0 && labels[labelIndex]) {
                        const deltaX = this.topologyInlineEditLinkX - renderLabel.baseLabelX
                        const deltaY = this.topologyInlineEditLinkY - renderLabel.baseLabelY
                        const nextOffsetAlong = Number((deltaX * renderItem.dirX + deltaY * renderItem.dirY).toFixed(2))
                        const nextOffsetNormal = Number((deltaX * renderItem.normalX + deltaY * renderItem.normalY).toFixed(2))
                        const nextOffsetX = Number((nextOffsetAlong * renderItem.dirX + nextOffsetNormal * renderItem.normalX).toFixed(2))
                        const nextOffsetY = Number((nextOffsetAlong * renderItem.dirY + nextOffsetNormal * renderItem.normalY).toFixed(2))
                        const currentLocal = this.getTopologyLinkLabelLocalOffsets(
                            labels[labelIndex],
                            renderItem.dirX,
                            renderItem.dirY,
                            renderItem.normalX,
                            renderItem.normalY,
                        )
                        if (
                            Math.abs(currentLocal.along - nextOffsetAlong) >= 0.01 ||
                            Math.abs(currentLocal.normal - nextOffsetNormal) >= 0.01 ||
                            Math.abs((labels[labelIndex].offsetX ?? 0) - nextOffsetX) >= 0.01 ||
                            Math.abs((labels[labelIndex].offsetY ?? 0) - nextOffsetY) >= 0.01
                        ) {
                            labels[labelIndex].offsetAlong = nextOffsetAlong
                            labels[labelIndex].offsetNormal = nextOffsetNormal
                            labels[labelIndex].offsetX = nextOffsetX
                            labels[labelIndex].offsetY = nextOffsetY
                            changed = true
                        }
                    }
                }
                if (changed) {
                    this.syncTopologyLegacyLinkLabelFields(link)
                }
            }
        } else if (this.topologyInlineEditShapeId) {
            const shape = this.topologyData.shapes.find(x => x.id === this.topologyInlineEditShapeId)
            if (shape && (shape.label ?? '') !== value) {
                shape.label = value
                changed = true
            }
        } else if (this.topologyInlineEditTextId) {
            const item = this.topologyData.texts.find(x => x.id === this.topologyInlineEditTextId)
            if (item && item.text !== value) {
                item.text = value
                changed = true
            }
        }
        this.clearTopologyInlineEditState()
        if (changed) {
            this.persistTopologyToDoc()
        } else {
            this.cdr.markForCheck()
        }
    }

    private cancelTopologyInlineEdit (): void {
        if (!this.hasTopologyInlineEdit()) {
            return
        }
        this.clearTopologyInlineEditState(true)
    }

    private resetTopologyFreeLinkDraftState (): void {
        this.topologyPendingFreeLinkStart = null
        this.topologyFreeLinkDraftEnd = null
        this.topologyFreeLinkCreating = false
        this.clearTopologyPointerSpaceCache()
    }

    private cancelTopologyFreeLinkHandleDrag (): void {
        this.topologyDragFreeLinkId = null
        this.topologyDragFreeLinkHandle = null
        this.topologyFreeLinkMoveStartPointerX = 0
        this.topologyFreeLinkMoveStartPointerY = 0
        this.topologyFreeLinkMoveStartX1 = 0
        this.topologyFreeLinkMoveStartY1 = 0
        this.topologyFreeLinkMoveStartX2 = 0
        this.topologyFreeLinkMoveStartY2 = 0
        this.topologyFreeLinkHandleDragChanged = false
        this.clearTopologyPointerSpaceCache()
    }

    private resetTopologyResizeState (): void {
        this.topologyResizeNodeId = null
        this.topologyNodeResizeChanged = false
        this.topologyResizeTextId = null
        this.topologyTextResizeChanged = false
        this.topologyResizeShapeId = null
        this.topologyShapeResizeChanged = false
    }

    toggleTopologyCanvasMode (): void {
        if (!this.topologyCanvasMode) {
            const doc = this.getActiveDoc()
            if (!doc || !this.isTopologyDocCandidate(doc)) {
                this.setError('Active file is not a topology document')
                return
            }
            this.topologyCanvasMode = true
            this.viewMode = 'editor'
            this.loadTopologyFromDoc(doc)
            this.layoutEditors()
            this.cdr.markForCheck()
            return
        }
        this.topologyCanvasMode = false
        this.topologyParseError = ''
        this.topologyPendingLinkSourceId = null
        this.topologyPendingLinkSourceKind = null
        this.topologyFreeLinkPlacementDirected = null
        this.resetTopologyFreeLinkDraftState()
        this.topologyTextPlacementMode = false
        this.topologyStickyNotePlacementMode = false
        this.clearTopologySelection()
        this.topologyDragNodeId = null
        this.topologyDragChanged = false
        this.resetTopologyResizeState()
        this.topologyDragTextId = null
        this.topologyTextDragChanged = false
        this.topologyDragShapeId = null
        this.topologyShapeDragChanged = false
        this.cancelTopologyFreeLinkHandleDrag()
        this.topologyPanDragActive = false
        this.topologyMarqueeActive = false
        this.topologyMarqueeWidthPx = 0
        this.topologyMarqueeHeightPx = 0
        this.layoutEditors()
        this.cdr.markForCheck()
    }

    addTopologyNode (nodeType = 'router'): void {
        if (!this.topologyData) {
            return
        }
        this.topologyFreeLinkPlacementDirected = null
        this.resetTopologyFreeLinkDraftState()
        this.cancelTopologyFreeLinkHandleDrag()
        const count = this.topologyData.nodes.length
        const viewport = this.getTopologyViewportWorldBounds()
        const x = Math.max(
            viewport.minX + 8,
            Math.min(viewport.maxX - this.topologyNodeWidthPx - 8, viewport.minX + 24 + (count % 6) * 180),
        )
        const y = Math.max(
            viewport.minY + 8,
            Math.min(viewport.maxY - this.topologyNodeHeightPx - 8, viewport.minY + 24 + Math.floor(count / 6) * 110),
        )
        const nodeId = this.createUniqueTopologyNodeId(nodeType)
        const labelStem = nodeType.charAt(0).toUpperCase() + nodeType.slice(1)
        this.topologyData.nodes.push({
            id: nodeId,
            type: nodeType,
            label: `${labelStem} ${count + 1}`,
            x,
            y,
            width: this.topologyNodeWidthPx,
            height: this.topologyNodeHeightPx,
            color: this.getTopologyDefaultNodeColor(),
        })
        this.setTopologySingleSelection('node', nodeId)
        this.persistTopologyToDoc()
        this.cdr.markForCheck()
    }

    addTopologyShape (kind: 'circle'|'oval'): void {
        if (!this.topologyData) {
            return
        }
        this.topologyFreeLinkPlacementDirected = null
        this.resetTopologyFreeLinkDraftState()
        this.cancelTopologyFreeLinkHandleDrag()
        const count = this.topologyData.shapes.length
        const viewport = this.getTopologyViewportWorldBounds()
        const width = kind === 'circle' ? 96 : 148
        const height = kind === 'circle' ? 96 : 96
        const x = Math.max(
            viewport.minX + 8,
            Math.min(viewport.maxX - width - 8, viewport.minX + 28 + (count % 6) * 170),
        )
        const y = Math.max(
            viewport.minY + 8,
            Math.min(viewport.maxY - height - 8, viewport.minY + 28 + Math.floor(count / 6) * 120),
        )
        const id = this.createUniqueTopologyShapeId()
        this.topologyData.shapes.push({
            id,
            kind,
            x,
            y,
            width,
            height,
            color: this.getTopologyDefaultShapeColor(),
        })
        this.setTopologySingleSelection('shape', id)
        this.persistTopologyToDoc()
        this.cdr.markForCheck()
    }

    toggleTopologyFreeLinkMode (directed: boolean): void {
        if (this.topologyTextPlacementMode) {
            this.topologyTextPlacementMode = false
        }
        if (this.topologyStickyNotePlacementMode) {
            this.topologyStickyNotePlacementMode = false
        }
        if (this.topologyPendingLinkSourceId) {
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
        }
        if (this.topologyFreeLinkPlacementDirected === directed) {
            this.topologyFreeLinkPlacementDirected = null
            this.resetTopologyFreeLinkDraftState()
            this.cancelTopologyFreeLinkHandleDrag()
            return
        }
        this.topologyFreeLinkPlacementDirected = directed
        this.resetTopologyFreeLinkDraftState()
        this.cancelTopologyFreeLinkHandleDrag()
    }

    toggleTopologyLinkMode (): void {
        if (this.topologyTextPlacementMode) {
            this.topologyTextPlacementMode = false
        }
        if (this.topologyStickyNotePlacementMode) {
            this.topologyStickyNotePlacementMode = false
        }
        this.topologyFreeLinkPlacementDirected = null
        this.resetTopologyFreeLinkDraftState()
        this.cancelTopologyFreeLinkHandleDrag()
        if (this.topologyPendingLinkSourceId) {
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
        } else {
            this.topologyPendingLinkSourceId = '__pending__'
            this.topologyPendingLinkSourceKind = null
        }
    }

    toggleTopologyCurvedLinksMode (): void {
        this.topologyCurvedLinks = !this.topologyCurvedLinks
        this.persistTopologyToDoc()
        this.scheduleTopologyRender()
    }

    toggleTopologyNewLinksDirectionMode (): void {
        if (this.hasTopologyLinkSelection) {
            const nextStyle = this.getNextTopologyLinkStyle(this.topologyLinkStyleToggleState)
            this.updateSelectedTopologyLinkDirection(nextStyle)
            this.cdr.markForCheck()
            return
        }
        this.topologyNewLinksDirected = !this.topologyNewLinksDirected
        this.persistTopologyToDoc()
        this.cdr.markForCheck()
    }

    toggleTopologyTextPlacementMode (): void {
        if (this.topologyPendingLinkSourceId) {
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
        }
        this.topologyFreeLinkPlacementDirected = null
        this.resetTopologyFreeLinkDraftState()
        this.cancelTopologyFreeLinkHandleDrag()
        this.topologyStickyNotePlacementMode = false
        this.topologyTextPlacementMode = !this.topologyTextPlacementMode
    }

    toggleTopologyStickyNotePlacementMode (): void {
        if (this.topologyPendingLinkSourceId) {
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
        }
        this.topologyFreeLinkPlacementDirected = null
        this.resetTopologyFreeLinkDraftState()
        this.cancelTopologyFreeLinkHandleDrag()
        this.topologyTextPlacementMode = false
        this.topologyStickyNotePlacementMode = !this.topologyStickyNotePlacementMode
    }

    zoomTopologyIn (): void {
        this.adjustTopologyZoom(1.12)
    }

    zoomTopologyOut (): void {
        this.adjustTopologyZoom(1 / 1.12)
    }

    resetTopologyViewport (): void {
        this.topologyZoom = 1
        this.topologyPanX = 0
        this.topologyPanY = 0
        this.cdr.markForCheck()
    }

    fitTopologyToCanvas (): void {
        if (!this.topologyData || !this.topologyCanvas?.nativeElement) {
            this.resetTopologyViewport()
            return
        }
        const canvasWidth = this.topologyCanvas.nativeElement.clientWidth || 1200
        const canvasHeight = this.topologyCanvas.nativeElement.clientHeight || 720
        const points: Array<{ x: number, y: number }> = []
        for (const node of this.topologyData.nodes) {
            const size = this.getTopologyNodeSize(node)
            points.push({ x: node.x, y: node.y })
            points.push({ x: node.x + size.width, y: node.y + size.height })
        }
        for (const shape of this.topologyData.shapes) {
            points.push({ x: shape.x, y: shape.y })
            points.push({ x: shape.x + shape.width, y: shape.y + shape.height })
        }
        for (const link of this.topologyData.links) {
            if ([link.x1, link.y1, link.x2, link.y2].every(v => Number.isFinite(Number(v)))) {
                points.push({ x: Number(link.x1), y: Number(link.y1) })
                points.push({ x: Number(link.x2), y: Number(link.y2) })
            }
        }
        for (const item of this.topologyData.texts) {
            const textSize = this.getTopologyStickyNoteSize(item)
            points.push({ x: item.x, y: item.y })
            points.push({ x: item.x + textSize.width, y: item.y + textSize.height })
        }
        if (!points.length) {
            this.resetTopologyViewport()
            return
        }
        const minX = Math.min(...points.map(p => p.x))
        const minY = Math.min(...points.map(p => p.y))
        const maxX = Math.max(...points.map(p => p.x))
        const maxY = Math.max(...points.map(p => p.y))
        const width = Math.max(120, maxX - minX)
        const height = Math.max(120, maxY - minY)
        const padding = 32
        const zoomX = (canvasWidth - padding * 2) / width
        const zoomY = (canvasHeight - padding * 2) / height
        this.topologyZoom = Math.max(0.35, Math.min(2.5, Math.min(zoomX, zoomY)))
        this.topologyPanX = Math.round((canvasWidth - width * this.topologyZoom) / 2 - minX * this.topologyZoom)
        this.topologyPanY = Math.round((canvasHeight - height * this.topologyZoom) / 2 - minY * this.topologyZoom)
        this.cdr.markForCheck()
    }

    onTopologyCanvasWheel (event: WheelEvent): void {
        if (!this.topologyCanvas?.nativeElement) {
            return
        }
        event.preventDefault()
        if (event.ctrlKey || event.metaKey) {
            const scaleFactor = event.deltaY < 0 ? 1.08 : (1 / 1.08)
            this.adjustTopologyZoom(scaleFactor, event.clientX, event.clientY)
            return
        }
        const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 18
            : (event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 120 : 1)
        const deltaX = Number.isFinite(event.deltaX) ? event.deltaX * modeScale : 0
        const deltaY = Number.isFinite(event.deltaY) ? event.deltaY * modeScale : 0
        if (Math.abs(deltaX) < 0.01 && Math.abs(deltaY) < 0.01) {
            return
        }
        this.topologyPanX = Math.round(this.topologyPanX - deltaX)
        this.topologyPanY = Math.round(this.topologyPanY - deltaY)
        this.clearTopologyPointerSpaceCache()
        this.scheduleTopologyRender()
    }

    runTopologyUndo (): void {
        if (!this.topologyUndoStack.length || !this.topologyData) {
            return
        }
        const current = this.serializeTopology(this.topologyData)
        const previous = this.topologyUndoStack.pop()
        if (!previous) {
            return
        }
        this.topologyRedoStack.push(current)
        this.applyTopologySnapshot(previous, true)
    }

    runTopologyRedo (): void {
        if (!this.topologyRedoStack.length || !this.topologyData) {
            return
        }
        const current = this.serializeTopology(this.topologyData)
        const next = this.topologyRedoStack.pop()
        if (!next) {
            return
        }
        this.topologyUndoStack.push(current)
        this.applyTopologySnapshot(next, true)
    }

    restorePreviousTopologySnapshot (): void {
        const doc = this.getActiveDoc()
        if (!doc || !this.topologyData) {
            return
        }
        const points = this.topologyRestorePointsByDoc.get(doc.id) ?? []
        if (points.length < 2) {
            return
        }
        const current = this.serializeTopology(this.topologyData)
        let candidate: TopologyRestorePoint|null = null
        for (let i = points.length - 1; i >= 0; i--) {
            if (points[i].serialized !== current) {
                candidate = points[i]
                break
            }
        }
        if (!candidate) {
            return
        }
        this.pushTopologyUndoState(current)
        this.topologyRedoStack = []
        this.applyTopologySnapshot(candidate.serialized, false)
    }

    alignSelectedTopologyNodes (mode: 'left'|'center'|'right'|'top'|'middle'|'bottom'): void {
        if (!this.topologyData) {
            return
        }
        const items = this.getSelectedTopologyLayoutItems()
        if (items.length < 2) {
            return
        }
        let changed = false
        if (mode === 'left') {
            const anchor = Math.min(...items.map(x => x.item.x))
            for (const target of items) {
                if (target.item.x !== anchor) {
                    target.item.x = anchor
                    changed = true
                }
            }
        } else if (mode === 'center') {
            const center = items.reduce((acc, target) => acc + target.item.x + target.width / 2, 0) / items.length
            for (const target of items) {
                const next = Math.round(center - target.width / 2)
                if (target.item.x !== next) {
                    target.item.x = next
                    changed = true
                }
            }
        } else if (mode === 'right') {
            const anchor = Math.max(...items.map(x => x.item.x + x.width))
            for (const target of items) {
                const next = anchor - target.width
                if (target.item.x !== next) {
                    target.item.x = next
                    changed = true
                }
            }
        } else if (mode === 'top') {
            const anchor = Math.min(...items.map(x => x.item.y))
            for (const target of items) {
                if (target.item.y !== anchor) {
                    target.item.y = anchor
                    changed = true
                }
            }
        } else if (mode === 'middle') {
            const middle = items.reduce((acc, target) => acc + target.item.y + target.height / 2, 0) / items.length
            for (const target of items) {
                const next = Math.round(middle - target.height / 2)
                if (target.item.y !== next) {
                    target.item.y = next
                    changed = true
                }
            }
        } else {
            const anchor = Math.max(...items.map(x => x.item.y + x.height))
            for (const target of items) {
                const next = anchor - target.height
                if (target.item.y !== next) {
                    target.item.y = next
                    changed = true
                }
            }
        }
        if (changed) {
            this.persistTopologyToDoc()
            this.cdr.markForCheck()
        }
    }

    distributeSelectedTopologyNodes (axis: 'horizontal'|'vertical'): void {
        if (!this.topologyData) {
            return
        }
        const items = this.getSelectedTopologyLayoutItems()
        if (items.length < 3) {
            return
        }
        const ordered = [...items].sort((a, b) => axis === 'horizontal' ? a.item.x - b.item.x : a.item.y - b.item.y)
        const start = axis === 'horizontal' ? ordered[0].item.x : ordered[0].item.y
        const end = axis === 'horizontal' ? ordered[ordered.length - 1].item.x : ordered[ordered.length - 1].item.y
        const span = end - start
        const step = span / (ordered.length - 1)
        let changed = false
        for (let i = 1; i < ordered.length - 1; i++) {
            const target = Math.round(start + step * i)
            if (axis === 'horizontal') {
                if (ordered[i].item.x !== target) {
                    ordered[i].item.x = target
                    changed = true
                }
            } else if (ordered[i].item.y !== target) {
                ordered[i].item.y = target
                changed = true
            }
        }
        if (changed) {
            this.persistTopologyToDoc()
            this.cdr.markForCheck()
        }
    }

    duplicateSelectedTopologyNodes (): void {
        if (!this.copySelectedTopologyNodesToClipboard()) {
            return
        }
        this.pasteTopologyNodesFromClipboard()
    }

    onTopologyCanvasBackgroundMouseDown (event: MouseEvent): void {
        this.topologyContextMenuOpen = false
        this.topologyContextMenuPoint = null
        this.topologyNodeContextMenuOpen = false
        this.topologyNodeContextMenuNodeId = null
        const target = event.target as HTMLElement | null
        if (target?.closest('.topology-node') || target?.closest('.topology-link') || target?.closest('.topology-link-hit') || target?.closest('.topology-link-end-hit') || target?.closest('.topology-link-label') || target?.closest('.topology-shape') || target?.closest('.topology-text-label') || target?.closest('.topology-link-handle') || target?.closest('.topology-link-inline-editor')) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            this.commitTopologyInlineEdit()
        }
        if (event.detail > 1) {
            return
        }
        if (event.button === 1 || (event.button === 0 && event.altKey)) {
            this.beginTopologyPanDrag(event, false)
            return
        }
        if (event.button !== 0) {
            return
        }
        const appendSelection = event.metaKey || event.ctrlKey || event.shiftKey
        if (this.topologyTextPlacementMode || this.topologyStickyNotePlacementMode) {
            if (!appendSelection) {
                this.clearTopologySelection()
                this.cdr.markForCheck()
            }
            const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
            if (point) {
                this.addTopologyTextAtPoint(point.x, point.y, false, this.topologyStickyNotePlacementMode)
                return
            }
            return
        }
        if (this.topologyFreeLinkPlacementDirected != null) {
            if (!appendSelection) {
                this.clearTopologySelection()
                this.cdr.markForCheck()
            }
            this.captureTopologyPointerSpaceCache()
            const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
            if (!point) {
                return
            }
            event.preventDefault()
            event.stopPropagation()
            this.cancelTopologyFreeLinkHandleDrag()
            this.topologyPendingFreeLinkStart = point
            this.topologyFreeLinkDraftEnd = point
            this.topologyFreeLinkCreating = true
            this.cdr.markForCheck()
            return
        }
        if (this.topologyPendingLinkSourceId === '__pending__') {
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
        }
        if (!appendSelection) {
            this.clearTopologySelection()
            this.cdr.markForCheck()
        }
        this.beginTopologyMarqueeDrag(event)
    }

    onTopologyCanvasContextMenu (event: MouseEvent): void {
        if (!this.topologyData) {
            return
        }
        const target = event.target as HTMLElement | null
        if (target?.closest('.topology-node') || target?.closest('.topology-link') || target?.closest('.topology-link-hit') || target?.closest('.topology-link-end-hit') || target?.closest('.topology-link-label') || target?.closest('.topology-shape') || target?.closest('.topology-text-label') || target?.closest('.topology-link-handle') || target?.closest('.topology-link-inline-editor')) {
            return
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.clearTopologySelection()
        this.topologyContextMenuPoint = point
        const menuWidth = 184
        const menuHeight = 44
        const padding = 8
        const maxX = Math.max(padding, (window.innerWidth || 0) - menuWidth - padding)
        const maxY = Math.max(padding, (window.innerHeight || 0) - menuHeight - padding)
        this.topologyContextMenuX = Math.max(padding, Math.min(event.clientX, maxX))
        this.topologyContextMenuY = Math.max(padding, Math.min(event.clientY, maxY))
        this.topologyContextMenuOpen = true
        this.cdr.markForCheck()
    }

    onTopologyNodeContextMenu (event: MouseEvent, nodeId: string): void {
        this.showTopologyItemContextMenu(event, nodeId, 'node')
    }

    onTopologyShapeContextMenu (event: MouseEvent, shapeId: string): void {
        this.showTopologyItemContextMenu(event, shapeId, 'shape')
    }

    private showTopologyItemContextMenu (event: MouseEvent, itemId: string, kind: 'node'|'shape'): void {
        if (!this.topologyData) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.topologyContextMenuOpen = false
        this.topologyContextMenuPoint = null
        this.topologyNodeContextMenuNodeId = itemId
        this.topologyNodeContextMenuKind = kind
        const menuWidth = 160
        const menuHeight = 44
        const padding = 8
        const maxX = Math.max(padding, (window.innerWidth || 0) - menuWidth - padding)
        const maxY = Math.max(padding, (window.innerHeight || 0) - menuHeight - padding)
        this.topologyNodeContextMenuX = Math.max(padding, Math.min(event.clientX, maxX))
        this.topologyNodeContextMenuY = Math.max(padding, Math.min(event.clientY, maxY))
        this.topologyNodeContextMenuOpen = true
        this.cdr.markForCheck()
    }

    addLinkFromNodeContextMenu (): void {
        const itemId = this.topologyNodeContextMenuNodeId
        const kind = this.topologyNodeContextMenuKind
        this.topologyNodeContextMenuOpen = false
        this.topologyNodeContextMenuNodeId = null
        if (!itemId || !this.topologyData) {
            return
        }
        this.topologyPendingLinkSourceId = itemId
        this.topologyPendingLinkSourceKind = kind
        this.setTopologySingleSelection(kind, itemId)
        this.cdr.markForCheck()
    }

    addStickyNoteFromTopologyContextMenu (): void {
        const point = this.topologyContextMenuPoint
        this.topologyContextMenuOpen = false
        this.topologyContextMenuPoint = null
        if (!point || !this.topologyData) {
            return
        }
        this.addTopologyTextAtPoint(point.x, point.y, true, true)
    }

    onTopologyCanvasDoubleClick (event: MouseEvent): void {
        if (event.button !== 0 || !this.topologyData) {
            return
        }
        if (this.topologyTextPlacementMode || this.topologyStickyNotePlacementMode) {
            return
        }
        const target = event.target as HTMLElement | null
        if (target?.closest('.topology-node') || target?.closest('.topology-link') || target?.closest('.topology-link-hit') || target?.closest('.topology-link-end-hit') || target?.closest('.topology-link-label') || target?.closest('.topology-shape') || target?.closest('.topology-text-label') || target?.closest('.topology-link-handle') || target?.closest('.topology-link-inline-editor')) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        this.addTopologyTextAtPoint(point.x, point.y, true)
    }

    onTopologyNodeClick (event: MouseEvent, nodeId: string): void {
        event.stopPropagation()
        if (!this.topologyData) {
            return
        }
        const appendSelection = event.metaKey || event.ctrlKey || event.shiftKey
        if (this.topologyPendingLinkSourceId && this.topologyPendingLinkSourceId !== '__pending__') {
            const sourceId = this.topologyPendingLinkSourceId
            const sourceKind = this.topologyPendingLinkSourceKind ?? 'node'
            if (!(sourceKind === 'node' && sourceId === nodeId)) {
                this.topologyData.links.push({
                    id: this.createUniqueTopologyLinkId(),
                    from: sourceId,
                    to: nodeId,
                    fromKind: sourceKind,
                    toKind: 'node',
                    label: '',
                    labels: [],
                    color: this.getTopologyDefaultLinkColor(),
                    directed: this.topologyNewLinksDirected,
                    bidirectional: false,
                })
                this.persistTopologyToDoc()
            }
            this.topologyPendingLinkSourceId = '__pending__'
            this.topologyPendingLinkSourceKind = null
            this.setTopologySingleSelection('node', nodeId)
            return
        }
        if (this.topologyPendingLinkSourceId === '__pending__') {
            this.topologyPendingLinkSourceId = nodeId
            this.topologyPendingLinkSourceKind = 'node'
            this.setTopologySingleSelection('node', nodeId)
            return
        }
        if (appendSelection) {
            this.toggleTopologySelection('node', nodeId)
        } else {
            this.setTopologySingleSelection('node', nodeId)
        }
    }

    onTopologyLinkClick (event: MouseEvent, linkId: string, labelId?: string): void {
        event.stopPropagation()
        const appendSelection = event.metaKey || event.ctrlKey || event.shiftKey
        if (appendSelection) {
            this.toggleTopologySelection('link', linkId)
        } else {
            this.setTopologySingleSelection('link', linkId)
        }
    }

    onTopologyLinkDoubleClick (event: MouseEvent, linkId: string, labelId?: string): void {
        event.preventDefault()
        event.stopPropagation()
        void this.editTopologyLinkLabelFromDoubleClick(event, linkId, labelId)
    }

    onTopologyShapeClick (event: MouseEvent, shapeId: string): void {
        event.stopPropagation()
        if (!this.topologyData) {
            return
        }
        if (this.topologyPendingLinkSourceId && this.topologyPendingLinkSourceId !== '__pending__') {
            const sourceId = this.topologyPendingLinkSourceId
            const sourceKind = this.topologyPendingLinkSourceKind ?? 'node'
            if (!(sourceKind === 'shape' && sourceId === shapeId)) {
                this.topologyData.links.push({
                    id: this.createUniqueTopologyLinkId(),
                    from: sourceId,
                    to: shapeId,
                    fromKind: sourceKind,
                    toKind: 'shape',
                    label: '',
                    labels: [],
                    color: this.getTopologyDefaultLinkColor(),
                    directed: this.topologyNewLinksDirected,
                    bidirectional: false,
                })
                this.persistTopologyToDoc()
            }
            this.topologyPendingLinkSourceId = '__pending__'
            this.topologyPendingLinkSourceKind = null
            this.setTopologySingleSelection('shape', shapeId)
            return
        }
        if (this.topologyPendingLinkSourceId === '__pending__') {
            this.topologyPendingLinkSourceId = shapeId
            this.topologyPendingLinkSourceKind = 'shape'
            this.setTopologySingleSelection('shape', shapeId)
            return
        }
        const appendSelection = event.metaKey || event.ctrlKey || event.shiftKey
        if (appendSelection) {
            this.toggleTopologySelection('shape', shapeId)
        } else {
            this.setTopologySingleSelection('shape', shapeId)
        }
    }

    onTopologyTextClick (event: MouseEvent, textId: string): void {
        event.stopPropagation()
        const appendSelection = event.metaKey || event.ctrlKey || event.shiftKey
        if (appendSelection) {
            this.toggleTopologySelection('text', textId)
        } else {
            this.setTopologySingleSelection('text', textId)
        }
    }

    async editTopologyNodeLabelFromDoubleClick (event: MouseEvent, nodeId: string): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        if (!this.topologyData) {
            return
        }
        if (this.isTopologyInlineEditingNode(nodeId)) {
            return
        }
        const node = this.topologyData.nodes.find(x => x.id === nodeId)
        if (!node) {
            return
        }
        this.setTopologySingleSelection('node', nodeId)
        this.beginTopologyInlineEdit('node', nodeId, node.label || node.id)
    }

    async editTopologyLinkLabelFromDoubleClick (event: MouseEvent, linkId: string, labelId?: string): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        if (!this.topologyData) {
            return
        }
        if (this.isTopologyInlineEditingLink(linkId, labelId ?? null)) {
            return
        }
        const link = this.topologyData.links.find(x => x.id === linkId)
        if (!link) {
            return
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        const renderItem = this.topologyLinkRenderItems.find(item => item.id === linkId)
        if (!labelId && event.shiftKey && point) {
            this.addTopologyTextAtPoint(point.x, point.y, true)
            return
        }
        let targetLabelId = labelId ?? null
        let anchorX: number|null = Number.isFinite(Number(point?.x)) ? Number(point?.x) : null
        let anchorY: number|null = Number.isFinite(Number(point?.y)) ? Number(point?.y) : null
        if (!targetLabelId && point && renderItem?.labels?.length) {
            const zoom = Math.max(0.1, this.topologyZoom || 1)
            const pickRadiusWorld = 12 / zoom
            const nearest = renderItem.labels.find(item => Math.hypot(item.labelX - point.x, item.labelY - point.y) <= pickRadiusWorld)
            if (nearest) {
                targetLabelId = nearest.id
            }
        }
        if (!targetLabelId) {
            const created = this.addTopologyLinkLabel(link, point?.x ?? null, point?.y ?? null)
            targetLabelId = created.id
            this.invalidateTopologyLinkRenderItems()
            this.scheduleTopologyRender()
        }
        const labels = this.getTopologyLinkLabels(link)
        const targetLabel = labels.find(item => item.id === targetLabelId) ?? null
        if (!targetLabel) {
            return
        }
        const renderLabel = this.topologyLinkRenderItems
            .find(item => item.id === linkId)
            ?.labels
            .find(item => item.id === targetLabelId)
        if (renderLabel) {
            anchorX = renderLabel.labelX
            anchorY = renderLabel.labelY
        }
        this.setTopologySingleSelection('link', linkId)
        this.beginTopologyInlineEdit(
            'link',
            linkId,
            targetLabel.text || '',
            anchorX,
            anchorY,
            targetLabel.id,
        )
    }

    async editTopologyTextFromDoubleClick (event: MouseEvent, textId: string): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        if (!this.topologyData) {
            return
        }
        if (this.isTopologyInlineEditingText(textId)) {
            return
        }
        const item = this.topologyData.texts.find(x => x.id === textId)
        if (!item) {
            return
        }
        if (item.sticky && item.collapsed) {
            item.collapsed = false
            this.persistTopologyToDoc()
        }
        this.setTopologySingleSelection('text', textId)
        this.beginTopologyInlineEdit('text', textId, item.text || '')
    }

    toggleTopologyStickyCollapsed (event: MouseEvent, textId: string): void {
        event.preventDefault()
        event.stopPropagation()
        if (!this.topologyData) {
            return
        }
        const item = this.topologyData.texts.find(x => x.id === textId)
        if (!item?.sticky) {
            return
        }
        if (this.topologyInlineEditTextId === textId) {
            this.commitTopologyInlineEdit()
        }
        item.collapsed = item.collapsed !== true
        this.setTopologySingleSelection('text', textId)
        this.persistTopologyToDoc()
    }

    toggleSelectedTopologyStickyCollapsed (): void {
        const item = this.selectedTopologyText
        if (!item?.sticky) {
            return
        }
        if (this.topologyInlineEditTextId === item.id) {
            this.commitTopologyInlineEdit()
        }
        item.collapsed = item.collapsed !== true
        this.persistTopologyToDoc()
    }

    async editTopologyShapeLabelFromDoubleClick (event: MouseEvent, shapeId: string): Promise<void> {
        event.preventDefault()
        event.stopPropagation()
        if (!this.topologyData) {
            return
        }
        if (this.isTopologyInlineEditingShape(shapeId)) {
            return
        }
        const shape = this.topologyData.shapes.find(x => x.id === shapeId)
        if (!shape) {
            return
        }
        this.setTopologySingleSelection('shape', shapeId)
        this.beginTopologyInlineEdit('shape', shapeId, shape.label || '')
    }

    startTopologyNodeDrag (event: MouseEvent, nodeId: string): void {
        if (!this.topologyData) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            return
        }
        if (this.topologyPendingLinkSourceId) {
            return
        }
        if (event.button !== 0) {
            return
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
            return
        }
        const node = this.topologyData.nodes.find(x => x.id === nodeId)
        if (!node) {
            return
        }
        this.captureTopologyPointerSpaceCache()
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.setTopologySingleSelection('node', nodeId)
        this.topologyDragNodeId = nodeId
        this.topologyDragChanged = false
        this.topologyDragOffsetX = point.x - node.x
        this.topologyDragOffsetY = point.y - node.y
    }

    startTopologyNodeResize (event: MouseEvent, nodeId: string): void {
        if (!this.topologyData || event.button !== 0) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            return
        }
        const node = this.topologyData.nodes.find(x => x.id === nodeId)
        if (!node) {
            return
        }
        this.captureTopologyPointerSpaceCache()
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.setTopologySingleSelection('node', nodeId)
        const size = this.getTopologyNodeSize(node)
        this.topologyResizeNodeId = nodeId
        this.topologyNodeResizeStartX = point.x
        this.topologyNodeResizeStartY = point.y
        this.topologyNodeResizeStartWidth = size.width
        this.topologyNodeResizeStartHeight = size.height
        this.topologyNodeResizeChanged = false
    }

    startTopologyTextDrag (event: MouseEvent, textId: string): void {
        if (!this.topologyData) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            return
        }
        if (event.button !== 0) {
            return
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
            return
        }
        const item = this.topologyData.texts.find(x => x.id === textId)
        if (!item) {
            return
        }
        this.captureTopologyPointerSpaceCache()
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.setTopologySingleSelection('text', textId)
        this.topologyDragTextId = textId
        this.topologyTextDragChanged = false
        this.topologyTextDragOffsetX = point.x - item.x
        this.topologyTextDragOffsetY = point.y - item.y
    }

    startTopologyTextResize (event: MouseEvent, textId: string): void {
        if (!this.topologyData || event.button !== 0) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            return
        }
        const item = this.topologyData.texts.find(x => x.id === textId)
        if (!item?.sticky) {
            return
        }
        this.captureTopologyPointerSpaceCache()
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.setTopologySingleSelection('text', textId)
        const size = this.getTopologyStickyNoteSize(item)
        this.topologyResizeTextId = textId
        this.topologyTextResizeStartX = point.x
        this.topologyTextResizeStartY = point.y
        this.topologyTextResizeStartWidth = size.width
        this.topologyTextResizeStartHeight = size.height
        this.topologyTextResizeChanged = false
    }

    startTopologyShapeDrag (event: MouseEvent, shapeId: string): void {
        if (!this.topologyData) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            return
        }
        if (this.topologyPendingLinkSourceId) {
            return
        }
        if (event.button !== 0) {
            return
        }
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
            return
        }
        const item = this.topologyData.shapes.find(x => x.id === shapeId)
        if (!item) {
            return
        }
        this.captureTopologyPointerSpaceCache()
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.setTopologySingleSelection('shape', shapeId)
        this.topologyDragShapeId = shapeId
        this.topologyShapeDragChanged = false
        this.topologyShapeDragOffsetX = point.x - item.x
        this.topologyShapeDragOffsetY = point.y - item.y
    }

    startTopologyShapeResize (event: MouseEvent, shapeId: string): void {
        if (!this.topologyData || event.button !== 0) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            return
        }
        const shape = this.topologyData.shapes.find(x => x.id === shapeId)
        if (!shape) {
            return
        }
        this.captureTopologyPointerSpaceCache()
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.setTopologySingleSelection('shape', shapeId)
        this.topologyResizeShapeId = shapeId
        this.topologyShapeResizeStartX = point.x
        this.topologyShapeResizeStartY = point.y
        this.topologyShapeResizeStartWidth = shape.width
        this.topologyShapeResizeStartHeight = shape.height
        this.topologyShapeResizeChanged = false
    }

    startTopologyFreeLinkHandleDrag (event: MouseEvent, linkId: string, handle: 'start'|'end'): void {
        if (!this.topologyData || event.button !== 0) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            return
        }
        const link = this.topologyData.links.find(x => x.id === linkId)
        if (!link || link.from || link.to) {
            return
        }
        if (![link.x1, link.y1, link.x2, link.y2].every(v => Number.isFinite(Number(v)))) {
            return
        }
        this.captureTopologyPointerSpaceCache()
        event.preventDefault()
        event.stopPropagation()
        this.setTopologySingleSelection('link', linkId)
        this.topologyDragFreeLinkId = linkId
        this.topologyDragFreeLinkHandle = handle
        this.topologyFreeLinkHandleDragChanged = false
        this.resetTopologyFreeLinkDraftState()
    }

    startTopologyFreeLinkDrag (event: MouseEvent, linkId: string): void {
        if (!this.topologyData || event.button !== 0) {
            return
        }
        if (this.hasTopologyInlineEdit()) {
            return
        }
        event.stopPropagation()
        if (event.metaKey || event.ctrlKey || event.shiftKey) {
            return
        }
        const link = this.topologyData.links.find(x => x.id === linkId)
        if (!link || link.from || link.to) {
            return
        }
        const x1 = Number(link.x1)
        const y1 = Number(link.y1)
        const x2 = Number(link.x2)
        const y2 = Number(link.y2)
        if (![x1, y1, x2, y2].every(Number.isFinite)) {
            return
        }
        this.captureTopologyPointerSpaceCache()
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.setTopologySingleSelection('link', linkId)
        this.topologyDragFreeLinkId = linkId
        this.topologyDragFreeLinkHandle = 'move'
        this.topologyFreeLinkMoveStartPointerX = point.x
        this.topologyFreeLinkMoveStartPointerY = point.y
        this.topologyFreeLinkMoveStartX1 = x1
        this.topologyFreeLinkMoveStartY1 = y1
        this.topologyFreeLinkMoveStartX2 = x2
        this.topologyFreeLinkMoveStartY2 = y2
        this.topologyFreeLinkHandleDragChanged = false
        this.resetTopologyFreeLinkDraftState()
    }

    updateSelectedTopologyNodeLabel (value: string): void {
        const node = this.selectedTopologyNode
        if (!node) {
            return
        }
        node.label = value
        this.persistTopologyToDoc()
    }

    updateSelectedTopologyNodeType (value: string): void {
        const node = this.selectedTopologyNode
        if (!node) {
            return
        }
        node.type = value || 'node'
        this.persistTopologyToDoc()
    }

    updateSelectedTopologyNodeColor (value: string): void {
        if (!this.topologyData) {
            return
        }
        const normalized = this.normalizeTopologyHexColor(value)
        if (!normalized) {
            return
        }
        let changed = false
        if (this.topologySelectedNodeIds.size) {
            for (const node of this.topologyData.nodes) {
                if (!this.topologySelectedNodeIds.has(node.id)) {
                    continue
                }
                if (node.color !== normalized) {
                    node.color = normalized
                    changed = true
                }
            }
        } else if (this.selectedTopologyNode) {
            if (this.selectedTopologyNode.color !== normalized) {
                this.selectedTopologyNode.color = normalized
                changed = true
            }
        }
        if (changed) {
            this.persistTopologyToDoc()
        }
    }

    updateSelectedTopologyLinkLabel (value: string): void {
        const link = this.selectedTopologyLink
        if (!link) {
            return
        }
        const primary = this.getTopologyPrimaryLinkLabel(link)
        if (primary) {
            primary.text = value
        } else if (value) {
            this.addTopologyLinkLabel(link, null, null, value)
        }
        this.syncTopologyLegacyLinkLabelFields(link)
        this.persistTopologyToDoc()
    }

    updateSelectedTopologyLinkColor (value: string): void {
        if (!this.topologyData) {
            return
        }
        const normalized = this.normalizeTopologyHexColor(value)
        if (!normalized) {
            return
        }
        let changed = false
        if (this.topologySelectedLinkIds.size) {
            for (const link of this.topologyData.links) {
                if (!this.topologySelectedLinkIds.has(link.id)) {
                    continue
                }
                if (link.color !== normalized) {
                    link.color = normalized
                    changed = true
                }
            }
        } else if (this.selectedTopologyLink) {
            if (this.selectedTopologyLink.color !== normalized) {
                this.selectedTopologyLink.color = normalized
                changed = true
            }
        }
        if (changed) {
            this.persistTopologyToDoc()
        }
    }

    updateSelectedTopologyLinkDirection (value: string): void {
        if (!this.topologyData) {
            return
        }
        const style: TopologyLinkStyle = value === 'double' ? 'double' : (value === 'line' ? 'line' : 'arrow')
        let changed = false
        if (this.topologySelectedLinkIds.size) {
            for (const link of this.topologyData.links) {
                if (!this.topologySelectedLinkIds.has(link.id)) {
                    continue
                }
                changed = this.applyTopologyLinkStyle(link, style) || changed
            }
        } else if (this.selectedTopologyLink) {
            changed = this.applyTopologyLinkStyle(this.selectedTopologyLink, style) || changed
        }
        if (changed) {
            this.persistTopologyToDoc()
        }
    }

    updateSelectedTopologyShapeKind (value: string): void {
        const shape = this.selectedTopologyShape
        if (!shape) {
            return
        }
        const nextKind = value === 'oval' ? 'oval' : 'circle'
        if (shape.kind === nextKind) {
            return
        }
        shape.kind = nextKind
        if (nextKind === 'circle') {
            const size = Math.max(24, Math.min(360, Math.round((shape.width + shape.height) / 2)))
            shape.width = size
            shape.height = size
        } else if (shape.width === shape.height) {
            shape.width = Math.max(48, Math.min(420, Math.round(shape.width * 1.45)))
            shape.height = Math.max(36, Math.min(320, Math.round(shape.height * 0.9)))
        }
        this.persistTopologyToDoc()
    }

    updateSelectedTopologyShapeSize (axis: 'width'|'height', value: number): void {
        const shape = this.selectedTopologyShape
        if (!shape || !Number.isFinite(value)) {
            return
        }
        const next = Math.max(20, Math.min(560, Math.round(value)))
        if (shape.kind === 'circle') {
            if (shape.width === next && shape.height === next) {
                return
            }
            shape.width = next
            shape.height = next
            this.persistTopologyToDoc()
            return
        }
        if (axis === 'width') {
            if (shape.width === next) {
                return
            }
            shape.width = next
        } else {
            if (shape.height === next) {
                return
            }
            shape.height = next
        }
        this.persistTopologyToDoc()
    }

    updateSelectedTopologyShapeColor (value: string): void {
        if (!this.topologyData) {
            return
        }
        const normalized = this.normalizeTopologyHexColor(value)
        if (!normalized) {
            return
        }
        let changed = false
        if (this.topologySelectedShapeIds.size) {
            for (const shape of this.topologyData.shapes) {
                if (!this.topologySelectedShapeIds.has(shape.id)) {
                    continue
                }
                if (shape.color !== normalized) {
                    shape.color = normalized
                    changed = true
                }
            }
        } else if (this.selectedTopologyShape) {
            if (this.selectedTopologyShape.color !== normalized) {
                this.selectedTopologyShape.color = normalized
                changed = true
            }
        }
        if (changed) {
            this.persistTopologyToDoc()
        }
    }

    updateSelectedTopologyShapeLabel (value: string): void {
        const shape = this.selectedTopologyShape
        if (!shape) {
            return
        }
        if ((shape.label ?? '') === value) {
            return
        }
        shape.label = value
        this.persistTopologyToDoc()
    }

    updateSelectedTopologyTextValue (value: string): void {
        const item = this.selectedTopologyText
        if (!item) {
            return
        }
        item.text = value
        this.persistTopologyToDoc()
    }

    updateSelectedTopologyTextColor (value: string): void {
        if (!this.topologyData) {
            return
        }
        const normalized = this.normalizeTopologyHexColor(value)
        if (!normalized) {
            return
        }
        let changed = false
        if (this.topologySelectedTextIds.size) {
            for (const item of this.topologyData.texts) {
                if (!this.topologySelectedTextIds.has(item.id)) {
                    continue
                }
                if (item.color !== normalized) {
                    item.color = normalized
                    changed = true
                }
            }
        } else if (this.selectedTopologyText) {
            if (this.selectedTopologyText.color !== normalized) {
                this.selectedTopologyText.color = normalized
                changed = true
            }
        }
        if (changed) {
            this.persistTopologyToDoc()
        }
    }

    updateSelectedTopologyTextSize (axis: 'width'|'height', value: number): void {
        const item = this.selectedTopologyText
        if (!item?.sticky || !Number.isFinite(value)) {
            return
        }
        const bounds = this.getTopologyStickyNoteSize(item)
        const next = axis === 'width'
            ? Math.max(100, Math.round(value))
            : Math.max(64, Math.round(value))
        if (axis === 'width') {
            if (Math.abs(bounds.width - next) < 0.01) {
                return
            }
            item.width = next
        } else {
            if (Math.abs(bounds.height - next) < 0.01) {
                return
            }
            item.height = next
        }
        this.persistTopologyToDoc()
    }

    removeSelectedTopologyItem (): void {
        if (!this.topologyData) {
            return
        }
        const nodeIds = new Set(this.topologySelectedNodeIds)
        const linkIds = new Set(this.topologySelectedLinkIds)
        const shapeIds = new Set(this.topologySelectedShapeIds)
        const textIds = new Set(this.topologySelectedTextIds)
        if (!nodeIds.size && this.selectedTopologyNode) {
            nodeIds.add(this.selectedTopologyNode.id)
        }
        if (!linkIds.size && this.selectedTopologyLink) {
            linkIds.add(this.selectedTopologyLink.id)
        }
        if (!shapeIds.size && this.selectedTopologyShape) {
            shapeIds.add(this.selectedTopologyShape.id)
        }
        if (!textIds.size && this.selectedTopologyText) {
            textIds.add(this.selectedTopologyText.id)
        }
        if (!nodeIds.size && !linkIds.size && !shapeIds.size && !textIds.size) {
            return
        }
        if (nodeIds.size) {
            this.topologyData.nodes = this.topologyData.nodes.filter(node => !nodeIds.has(node.id))
            this.topologyData.links = this.topologyData.links.filter(link => {
                const fromKind: TopologyLinkEndpointKind = link.fromKind === 'shape' ? 'shape' : 'node'
                const toKind: TopologyLinkEndpointKind = link.toKind === 'shape' ? 'shape' : 'node'
                const fromMatches = fromKind === 'node' && !!link.from && nodeIds.has(link.from)
                const toMatches = toKind === 'node' && !!link.to && nodeIds.has(link.to)
                return !fromMatches && !toMatches
            })
        }
        if (linkIds.size) {
            this.topologyData.links = this.topologyData.links.filter(link => !linkIds.has(link.id))
        }
        if (shapeIds.size) {
            this.topologyData.shapes = this.topologyData.shapes.filter(item => !shapeIds.has(item.id))
            this.topologyData.links = this.topologyData.links.filter(link => {
                const fromKind: TopologyLinkEndpointKind = link.fromKind === 'shape' ? 'shape' : 'node'
                const toKind: TopologyLinkEndpointKind = link.toKind === 'shape' ? 'shape' : 'node'
                const fromMatches = fromKind === 'shape' && !!link.from && shapeIds.has(link.from)
                const toMatches = toKind === 'shape' && !!link.to && shapeIds.has(link.to)
                return !fromMatches && !toMatches
            })
        }
        if (textIds.size) {
            this.topologyData.texts = this.topologyData.texts.filter(item => !textIds.has(item.id))
        }
        this.clearTopologySelection()
        this.persistTopologyToDoc()
    }

    private copySelectedTopologyNodesToClipboard (): boolean {
        if (!this.topologyData) {
            return false
        }
        const nodeIds = new Set(this.topologySelectedNodeIds)
        const shapeIds = new Set(this.topologySelectedShapeIds)
        const textIds = new Set(this.topologySelectedTextIds)
        if (!nodeIds.size && this.selectedTopologyNode) {
            nodeIds.add(this.selectedTopologyNode.id)
        }
        if (!shapeIds.size && this.selectedTopologyShape) {
            shapeIds.add(this.selectedTopologyShape.id)
        }
        if (!textIds.size && this.selectedTopologyText) {
            textIds.add(this.selectedTopologyText.id)
        }
        if (!nodeIds.size && !shapeIds.size && !textIds.size) {
            return false
        }

        const nodes = this.topologyData.nodes
            .filter(node => nodeIds.has(node.id))
            .map(node => ({ ...node }))
        const shapes = this.topologyData.shapes
            .filter(shape => shapeIds.has(shape.id))
            .map(shape => ({ ...shape }))
        const texts = this.topologyData.texts
            .filter(item => textIds.has(item.id))
            .map(item => ({ ...item }))
        if (!nodes.length && !shapes.length && !texts.length) {
            return false
        }

        const links = this.topologyData.links
            .filter(link => {
                if (!link.from || !link.to) {
                    return false
                }
                const fromKind: TopologyLinkEndpointKind = link.fromKind === 'shape' ? 'shape' : 'node'
                const toKind: TopologyLinkEndpointKind = link.toKind === 'shape' ? 'shape' : 'node'
                const fromSelected = fromKind === 'shape' ? shapeIds.has(link.from) : nodeIds.has(link.from)
                const toSelected = toKind === 'shape' ? shapeIds.has(link.to) : nodeIds.has(link.to)
                return fromSelected && toSelected
            })
            .map(link => ({
                ...link,
                labels: this.getTopologyLinkLabels(link).map(label => ({ ...label })),
            }))

        this.topologyNodeClipboard = { nodes, shapes, texts, links }
        this.topologyNodePasteSerial = 0
        return true
    }

    private pasteTopologyNodesFromClipboard (): boolean {
        if (!this.topologyData || !this.topologyNodeClipboard) {
            return false
        }
        const sourceNodes = this.topologyNodeClipboard.nodes ?? []
        const sourceShapes = this.topologyNodeClipboard.shapes ?? []
        const sourceTexts = this.topologyNodeClipboard.texts ?? []
        if (!sourceNodes.length && !sourceShapes.length && !sourceTexts.length) {
            return false
        }
        const viewport = this.getTopologyViewportWorldBounds()
        this.topologyNodePasteSerial += 1
        const offset = 24 * this.topologyNodePasteSerial

        const nodeIdMap = new Map<string, string>()
        const shapeIdMap = new Map<string, string>()
        const createdNodeIds: string[] = []
        const createdShapeIds: string[] = []
        const createdTextIds: string[] = []
        for (const sourceNode of sourceNodes) {
            const nextId = this.createUniqueTopologyNodeId(sourceNode.type || 'node')
            const nextX = Math.max(
                viewport.minX + 8,
                Math.min(viewport.maxX - this.topologyNodeWidthPx - 8, Math.round(sourceNode.x + offset)),
            )
            const nextY = Math.max(
                viewport.minY + 8,
                Math.min(viewport.maxY - this.topologyNodeHeightPx - 8, Math.round(sourceNode.y + offset)),
            )
            const nextNode: TopologyNodeModel = {
                ...sourceNode,
                id: nextId,
                x: nextX,
                y: nextY,
                color: this.normalizeTopologyHexColor(sourceNode.color) ?? this.getTopologyDefaultNodeColor(),
            }
            nodeIdMap.set(sourceNode.id, nextId)
            createdNodeIds.push(nextId)
            this.topologyData.nodes.push(nextNode)
        }

        for (const sourceShape of sourceShapes) {
            const nextId = this.createUniqueTopologyShapeId()
            const sourceWidth = Math.max(20, Math.min(560, Number(sourceShape.width) || 96))
            const sourceHeight = Math.max(20, Math.min(560, Number(sourceShape.height) || 96))
            const diameter = Math.max(sourceWidth, sourceHeight)
            const nextWidth = sourceShape.kind === 'circle' ? diameter : sourceWidth
            const nextHeight = sourceShape.kind === 'circle' ? diameter : sourceHeight
            const nextX = Math.max(
                viewport.minX + 8,
                Math.min(viewport.maxX - nextWidth - 8, Math.round(sourceShape.x + offset)),
            )
            const nextY = Math.max(
                viewport.minY + 8,
                Math.min(viewport.maxY - nextHeight - 8, Math.round(sourceShape.y + offset)),
            )
            const nextShape: TopologyShapeModel = {
                ...sourceShape,
                id: nextId,
                x: nextX,
                y: nextY,
                width: nextWidth,
                height: nextHeight,
                color: this.normalizeTopologyHexColor(sourceShape.color) ?? this.getTopologyDefaultShapeColor(),
            }
            shapeIdMap.set(sourceShape.id, nextId)
            createdShapeIds.push(nextId)
            this.topologyData.shapes.push(nextShape)
        }

        for (const sourceText of sourceTexts) {
            const nextId = this.createUniqueTopologyTextId()
            const sticky = sourceText.sticky === true
            const stickyWidthRaw = Number(sourceText.width)
            const stickyHeightRaw = Number(sourceText.height)
            const stickyWidth = Number.isFinite(stickyWidthRaw) ? Math.max(100, stickyWidthRaw) : undefined
            const stickyHeight = Number.isFinite(stickyHeightRaw) ? Math.max(64, stickyHeightRaw) : undefined
            const nextX = sticky
                ? Math.round(sourceText.x + offset)
                : Math.max(
                    viewport.minX + 8,
                    Math.min(viewport.maxX - 24, Math.round(sourceText.x + offset)),
                )
            const nextY = sticky
                ? Math.round(sourceText.y + offset)
                : Math.max(
                    viewport.minY + 8,
                    Math.min(viewport.maxY - 24, Math.round(sourceText.y + offset)),
                )
            const nextText: TopologyTextModel = {
                ...sourceText,
                id: nextId,
                x: nextX,
                y: nextY,
                collapsed: sticky ? sourceText.collapsed === true : false,
                width: sticky ? stickyWidth : undefined,
                height: sticky ? stickyHeight : undefined,
                color: this.normalizeTopologyHexColor(sourceText.color) ?? (sticky ? this.getTopologyDefaultStickyNoteColor() : this.getTopologyDefaultTextColor()),
            }
            createdTextIds.push(nextId)
            this.topologyData.texts.push(nextText)
        }

        for (const sourceLink of this.topologyNodeClipboard.links) {
            if (!sourceLink.from || !sourceLink.to) {
                continue
            }
            const fromKind: TopologyLinkEndpointKind = sourceLink.fromKind === 'shape' ? 'shape' : 'node'
            const toKind: TopologyLinkEndpointKind = sourceLink.toKind === 'shape' ? 'shape' : 'node'
            const from = fromKind === 'shape'
                ? shapeIdMap.get(sourceLink.from)
                : nodeIdMap.get(sourceLink.from)
            const to = toKind === 'shape'
                ? shapeIdMap.get(sourceLink.to)
                : nodeIdMap.get(sourceLink.to)
            if (!from || !to || from === to) {
                continue
            }
            const nextLink: TopologyLinkModel = {
                ...sourceLink,
                id: this.createUniqueTopologyLinkId(),
                from,
                to,
                fromKind,
                toKind,
                labels: (sourceLink.labels ?? []).map(label => ({ ...label })),
                color: this.normalizeTopologyHexColor(sourceLink.color) ?? this.getTopologyDefaultLinkColor(),
                directed: sourceLink.directed !== false || sourceLink.bidirectional === true,
                bidirectional: sourceLink.bidirectional === true,
            }
            this.syncTopologyLegacyLinkLabelFields(nextLink)
            this.topologyData.links.push(nextLink)
        }

        this.clearTopologySelection()
        for (const nodeId of createdNodeIds) {
            this.topologySelectedNodeIds.add(nodeId)
        }
        for (const shapeId of createdShapeIds) {
            this.topologySelectedShapeIds.add(shapeId)
        }
        for (const textId of createdTextIds) {
            this.topologySelectedTextIds.add(textId)
        }
        this.syncTopologyPrimarySelectionFromSets()
        this.persistTopologyToDoc()
        this.cdr.markForCheck()
        return true
    }

    private addTopologyTextAtPoint (x: number, y: number, startInlineEdit = false, sticky = false): string|null {
        if (!this.topologyData) {
            return null
        }
        const viewport = this.getTopologyViewportWorldBounds()
        const nextX = sticky
            ? x
            : Math.max(viewport.minX + 8, Math.min(viewport.maxX - 24, x))
        const nextY = sticky
            ? y
            : Math.max(viewport.minY + 8, Math.min(viewport.maxY - 24, y))
        const id = this.createUniqueTopologyTextId()
        const initialText = startInlineEdit ? '' : (sticky ? 'Note' : 'Text')
        this.topologyData.texts.push({
            id,
            text: initialText,
            x: nextX,
            y: nextY,
            sticky,
            collapsed: false,
            width: sticky ? this.topologyStickyDefaultWidthPx : undefined,
            height: sticky ? this.topologyStickyDefaultHeightPx : undefined,
            color: sticky ? this.getTopologyDefaultStickyNoteColor() : this.getTopologyDefaultTextColor(),
        })
        this.setTopologySingleSelection('text', id)
        this.persistTopologyToDoc()
        if (startInlineEdit) {
            this.beginTopologyInlineEdit('text', id, initialText)
        }
        this.cdr.markForCheck()
        return id
    }

    private updateTopologyFreeLinkDraft (event: MouseEvent): boolean {
        if (!this.topologyFreeLinkCreating || !this.topologyPendingFreeLinkStart) {
            return false
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return false
        }
        const previous = this.topologyFreeLinkDraftEnd
        if (previous && Math.abs(previous.x - point.x) < 0.01 && Math.abs(previous.y - point.y) < 0.01) {
            return false
        }
        this.topologyFreeLinkDraftEnd = point
        this.scheduleTopologyRender()
        return true
    }

    private finishTopologyFreeLinkDraft (): void {
        if (!this.topologyFreeLinkCreating) {
            return
        }
        if (this.topologyData && this.topologyPendingFreeLinkStart && this.topologyFreeLinkDraftEnd && this.topologyFreeLinkPlacementDirected != null) {
            const start = this.topologyPendingFreeLinkStart
            const end = this.topologyFreeLinkDraftEnd
            const dx = end.x - start.x
            const dy = end.y - start.y
            if (Math.hypot(dx, dy) >= 3) {
                const id = this.createUniqueTopologyLinkId()
                this.topologyData.links.push({
                    id,
                    x1: Number(start.x.toFixed(2)),
                    y1: Number(start.y.toFixed(2)),
                    x2: Number(end.x.toFixed(2)),
                    y2: Number(end.y.toFixed(2)),
                    label: '',
                    labels: [],
                    color: this.getTopologyDefaultLinkColor(),
                    directed: this.topologyFreeLinkPlacementDirected,
                    bidirectional: false,
                })
                this.setTopologySingleSelection('link', id)
                this.persistTopologyToDoc()
            }
        }
        this.resetTopologyFreeLinkDraftState()
        this.cdr.markForCheck()
    }

    private moveTopologyDragNode (event: MouseEvent): boolean {
        if (!this.topologyData || !this.topologyDragNodeId) {
            return false
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return false
        }
        const node = this.topologyData.nodes.find(x => x.id === this.topologyDragNodeId)
        if (!node) {
            return false
        }
        const size = this.getTopologyNodeSize(node)
        const viewport = this.getTopologyViewportWorldBounds()
        const nextX = Math.max(
            viewport.minX + 8,
            Math.min(viewport.maxX - size.width - 8, point.x - this.topologyDragOffsetX),
        )
        const nextY = Math.max(
            viewport.minY + 8,
            Math.min(viewport.maxY - size.height - 8, point.y - this.topologyDragOffsetY),
        )
        if (nextX === node.x && nextY === node.y) {
            return false
        }
        node.x = nextX
        node.y = nextY
        this.topologyDragChanged = true
        this.scheduleTopologyRender()
        return true
    }

    private moveTopologyResizeNode (event: MouseEvent): boolean {
        if (!this.topologyData || !this.topologyResizeNodeId) {
            return false
        }
        const node = this.topologyData.nodes.find(x => x.id === this.topologyResizeNodeId)
        if (!node) {
            return false
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return false
        }
        const viewport = this.getTopologyViewportWorldBounds()
        const dx = point.x - this.topologyNodeResizeStartX
        const dy = point.y - this.topologyNodeResizeStartY
        const maxWidth = Math.max(80, viewport.maxX - node.x - 8)
        const maxHeight = Math.max(56, viewport.maxY - node.y - 8)
        const nextWidth = Math.max(80, Math.min(560, Math.min(maxWidth, this.topologyNodeResizeStartWidth + dx)))
        const nextHeight = Math.max(56, Math.min(320, Math.min(maxHeight, this.topologyNodeResizeStartHeight + dy)))
        const normalizedWidth = Number(nextWidth.toFixed(2))
        const normalizedHeight = Number(nextHeight.toFixed(2))
        if (Math.abs(this.getTopologyNodeWidth(node) - normalizedWidth) < 0.01 && Math.abs(this.getTopologyNodeHeight(node) - normalizedHeight) < 0.01) {
            return false
        }
        node.width = normalizedWidth
        node.height = normalizedHeight
        this.topologyNodeResizeChanged = true
        this.scheduleTopologyRender()
        return true
    }

    private moveTopologyDragText (event: MouseEvent): boolean {
        if (!this.topologyData || !this.topologyDragTextId) {
            return false
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return false
        }
        const item = this.topologyData.texts.find(x => x.id === this.topologyDragTextId)
        if (!item) {
            return false
        }
        const viewport = this.getTopologyViewportWorldBounds()
        const nextX = item.sticky
            ? point.x - this.topologyTextDragOffsetX
            : Math.max(viewport.minX + 8, Math.min(viewport.maxX - 24, point.x - this.topologyTextDragOffsetX))
        const nextY = item.sticky
            ? point.y - this.topologyTextDragOffsetY
            : Math.max(viewport.minY + 8, Math.min(viewport.maxY - 24, point.y - this.topologyTextDragOffsetY))
        if (nextX === item.x && nextY === item.y) {
            return false
        }
        item.x = nextX
        item.y = nextY
        this.topologyTextDragChanged = true
        this.scheduleTopologyRender()
        return true
    }

    private moveTopologyResizeText (event: MouseEvent): boolean {
        if (!this.topologyData || !this.topologyResizeTextId) {
            return false
        }
        const item = this.topologyData.texts.find(x => x.id === this.topologyResizeTextId)
        if (!item?.sticky) {
            return false
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return false
        }
        const dx = point.x - this.topologyTextResizeStartX
        const dy = point.y - this.topologyTextResizeStartY
        const nextWidth = Math.max(100, this.topologyTextResizeStartWidth + dx)
        const nextHeight = Math.max(64, this.topologyTextResizeStartHeight + dy)
        const normalizedWidth = Number(nextWidth.toFixed(2))
        const normalizedHeight = Number(nextHeight.toFixed(2))
        const current = this.getTopologyStickyNoteSize(item)
        if (Math.abs(current.width - normalizedWidth) < 0.01 && Math.abs(current.height - normalizedHeight) < 0.01) {
            return false
        }
        item.width = normalizedWidth
        item.height = normalizedHeight
        this.topologyTextResizeChanged = true
        this.scheduleTopologyRender()
        return true
    }

    private moveTopologyDragShape (event: MouseEvent): boolean {
        if (!this.topologyData || !this.topologyDragShapeId) {
            return false
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return false
        }
        const shape = this.topologyData.shapes.find(x => x.id === this.topologyDragShapeId)
        if (!shape) {
            return false
        }
        const viewport = this.getTopologyViewportWorldBounds()
        const nextX = Math.max(viewport.minX + 8, Math.min(viewport.maxX - shape.width - 8, point.x - this.topologyShapeDragOffsetX))
        const nextY = Math.max(viewport.minY + 8, Math.min(viewport.maxY - shape.height - 8, point.y - this.topologyShapeDragOffsetY))
        if (nextX === shape.x && nextY === shape.y) {
            return false
        }
        shape.x = nextX
        shape.y = nextY
        this.topologyShapeDragChanged = true
        this.scheduleTopologyRender()
        return true
    }

    private moveTopologyResizeShape (event: MouseEvent): boolean {
        if (!this.topologyData || !this.topologyResizeShapeId) {
            return false
        }
        const shape = this.topologyData.shapes.find(x => x.id === this.topologyResizeShapeId)
        if (!shape) {
            return false
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return false
        }
        const viewport = this.getTopologyViewportWorldBounds()
        const dx = point.x - this.topologyShapeResizeStartX
        const dy = point.y - this.topologyShapeResizeStartY
        const maxWidth = Math.max(20, viewport.maxX - shape.x - 8)
        const maxHeight = Math.max(20, viewport.maxY - shape.y - 8)
        let nextWidth = this.topologyShapeResizeStartWidth + dx
        let nextHeight = this.topologyShapeResizeStartHeight + dy
        if (shape.kind === 'circle') {
            const size = Math.max(nextWidth, nextHeight)
            const maxSize = Math.max(20, Math.min(560, Math.min(maxWidth, maxHeight)))
            const clampedSize = Math.max(20, Math.min(maxSize, size))
            nextWidth = clampedSize
            nextHeight = clampedSize
        } else {
            nextWidth = Math.max(20, Math.min(560, Math.min(maxWidth, nextWidth)))
            nextHeight = Math.max(20, Math.min(560, Math.min(maxHeight, nextHeight)))
        }
        const normalizedWidth = Number(nextWidth.toFixed(2))
        const normalizedHeight = Number(nextHeight.toFixed(2))
        if (Math.abs(shape.width - normalizedWidth) < 0.01 && Math.abs(shape.height - normalizedHeight) < 0.01) {
            return false
        }
        shape.width = normalizedWidth
        shape.height = normalizedHeight
        this.topologyShapeResizeChanged = true
        this.scheduleTopologyRender()
        return true
    }

    private moveTopologyFreeLinkHandleDrag (event: MouseEvent): boolean {
        if (!this.topologyData || !this.topologyDragFreeLinkId || !this.topologyDragFreeLinkHandle) {
            return false
        }
        const link = this.topologyData.links.find(x => x.id === this.topologyDragFreeLinkId)
        if (!link || link.from || link.to) {
            return false
        }
        const point = this.getTopologyCanvasPoint(event.clientX, event.clientY)
        if (!point) {
            return false
        }
        if (this.topologyDragFreeLinkHandle === 'move') {
            const dx = point.x - this.topologyFreeLinkMoveStartPointerX
            const dy = point.y - this.topologyFreeLinkMoveStartPointerY
            const nextX1 = Number((this.topologyFreeLinkMoveStartX1 + dx).toFixed(2))
            const nextY1 = Number((this.topologyFreeLinkMoveStartY1 + dy).toFixed(2))
            const nextX2 = Number((this.topologyFreeLinkMoveStartX2 + dx).toFixed(2))
            const nextY2 = Number((this.topologyFreeLinkMoveStartY2 + dy).toFixed(2))
            if (
                Math.abs((link.x1 ?? 0) - nextX1) < 0.01 &&
                Math.abs((link.y1 ?? 0) - nextY1) < 0.01 &&
                Math.abs((link.x2 ?? 0) - nextX2) < 0.01 &&
                Math.abs((link.y2 ?? 0) - nextY2) < 0.01
            ) {
                return false
            }
            link.x1 = nextX1
            link.y1 = nextY1
            link.x2 = nextX2
            link.y2 = nextY2
            this.topologyFreeLinkHandleDragChanged = true
            this.scheduleTopologyRender()
            return true
        }
        const nextX = point.x
        const nextY = point.y
        if (this.topologyDragFreeLinkHandle === 'start') {
            if (Math.abs((link.x1 ?? 0) - nextX) < 0.01 && Math.abs((link.y1 ?? 0) - nextY) < 0.01) {
                return false
            }
            link.x1 = Number(nextX.toFixed(2))
            link.y1 = Number(nextY.toFixed(2))
        } else {
            if (Math.abs((link.x2 ?? 0) - nextX) < 0.01 && Math.abs((link.y2 ?? 0) - nextY) < 0.01) {
                return false
            }
            link.x2 = Number(nextX.toFixed(2))
            link.y2 = Number(nextY.toFixed(2))
        }
        this.topologyFreeLinkHandleDragChanged = true
        this.scheduleTopologyRender()
        return true
    }

    private captureTopologyPointerSpaceCache (): void {
        const el = this.topologyCanvas?.nativeElement
        if (!el) {
            this.topologyPointerSpaceCache = null
            return
        }
        const rect = el.getBoundingClientRect()
        this.topologyPointerSpaceCache = {
            left: rect.left,
            top: rect.top,
            panX: this.topologyPanX,
            panY: this.topologyPanY,
            zoom: Math.max(0.1, this.topologyZoom || 1),
        }
    }

    private clearTopologyPointerSpaceCache (): void {
        this.topologyPointerSpaceCache = null
    }

    private invalidateTopologyLinkRenderItems (): void {
        this.topologyLinkRenderItemsDirty = true
    }

    private scheduleTopologyRender (): void {
        this.invalidateTopologyLinkRenderItems()
        if (this.topologyRenderRaf != null) {
            return
        }
        this.topologyRenderRaf = window.requestAnimationFrame(() => {
            this.topologyRenderRaf = undefined
            this.cdr.markForCheck()
        })
    }

    private getTopologyCanvasPoint (clientX: number, clientY: number): { x: number, y: number }|null {
        let cache = this.topologyPointerSpaceCache
        if (!cache) {
            const el = this.topologyCanvas?.nativeElement
            if (!el) {
                return null
            }
            const rect = el.getBoundingClientRect()
            cache = {
                left: rect.left,
                top: rect.top,
                panX: this.topologyPanX,
                panY: this.topologyPanY,
                zoom: Math.max(0.1, this.topologyZoom || 1),
            }
            this.topologyPointerSpaceCache = cache
        }
        const rawX = clientX - cache.left
        const rawY = clientY - cache.top
        return {
            x: (rawX - cache.panX) / cache.zoom,
            y: (rawY - cache.panY) / cache.zoom,
        }
    }

    private getTopologyViewportWorldBounds (): { minX: number, minY: number, maxX: number, maxY: number } {
        const canvasWidth = this.topologyCanvas?.nativeElement?.clientWidth ?? 1200
        const canvasHeight = this.topologyCanvas?.nativeElement?.clientHeight ?? 720
        const zoom = Math.max(0.1, this.topologyZoom || 1)
        const minX = -this.topologyPanX / zoom
        const minY = -this.topologyPanY / zoom
        return {
            minX,
            minY,
            maxX: minX + canvasWidth / zoom,
            maxY: minY + canvasHeight / zoom,
        }
    }

    private getTopologyNodeSize (node: TopologyNodeModel): { width: number, height: number } {
        const widthRaw = Number(node.width)
        const heightRaw = Number(node.height)
        const width = Number.isFinite(widthRaw) ? widthRaw : this.topologyNodeWidthPx
        const height = Number.isFinite(heightRaw) ? heightRaw : this.topologyNodeHeightPx
        return {
            width: Math.max(80, Math.min(560, width)),
            height: Math.max(56, Math.min(320, height)),
        }
    }

    private getTopologyStickyNoteSize (item: TopologyTextModel): { width: number, height: number } {
        if (!item.sticky) {
            return { width: 120, height: 28 }
        }
        const widthRaw = Number(item.width)
        const heightRaw = Number(item.height)
        const width = Number.isFinite(widthRaw) ? widthRaw : 176
        if (item.collapsed) {
            return {
                width: Math.max(100, width),
                height: this.topologyStickyCollapsedHeightPx,
            }
        }
        const autoHeight = this.getTopologyStickyContentHeight(item.text, width)
        const height = Number.isFinite(heightRaw) ? heightRaw : autoHeight
        return {
            width: Math.max(100, width),
            height: Math.max(autoHeight, Math.max(64, height)),
        }
    }

    private getTopologyStickyContentHeight (text: string, width: number): number {
        const value = String(text ?? '')
        const contentWidth = Math.max(72, (Number.isFinite(width) ? width : 176) - 20)
        const charsPerVisualLine = Math.max(8, Math.floor(contentWidth / 7.2))
        let visualLines = 0
        const logicalLines = value.split(/\r?\n/)
        for (const rawLine of logicalLines) {
            const expanded = rawLine.replace(/\t/g, '    ')
            const units = Math.max(1, expanded.length)
            visualLines += Math.max(1, Math.ceil(units / charsPerVisualLine))
        }
        return Math.max(64, Math.ceil(visualLines * 17 + 20))
    }

    private serializeTopology (value: TopologyDocumentModel): string {
        const links = (value.links ?? []).map(link => {
            const next: TopologyLinkModel = {
                ...link,
                labels: this.getTopologyLinkLabels(link).map(label => ({ ...label })),
            }
            this.syncTopologyLegacyLinkLabelFields(next)
            return next
        })
        const normalized: TopologyDocumentModel = {
            ...value,
            type: 'tlink-topology',
            nodes: [...(value.nodes ?? [])],
            links,
            shapes: [...(value.shapes ?? [])],
            texts: [...(value.texts ?? [])],
            metadata: { ...(value.metadata ?? {}) },
        }
        return JSON.stringify(normalized)
    }

    private pushTopologyUndoState (serialized: string): void {
        if (!serialized) {
            return
        }
        this.topologyUndoStack.push(serialized)
        while (this.topologyUndoStack.length > this.topologyUndoLimit) {
            this.topologyUndoStack.shift()
        }
    }

    private captureTopologyRestorePoint (docId: string, serialized: string, force = false): void {
        if (!docId || !serialized) {
            return
        }
        const points = this.topologyRestorePointsByDoc.get(docId) ?? []
        const last = points[points.length - 1]
        if (last?.serialized === serialized) {
            return
        }
        const now = Date.now()
        if (!force && last && now - last.timestamp < this.topologyRestorePointMinIntervalMs) {
            return
        }
        points.push({ timestamp: now, serialized })
        while (points.length > this.topologyRestorePointLimit) {
            points.shift()
        }
        this.topologyRestorePointsByDoc.set(docId, points)
    }

    private commitTopologyHistoryIfChanged (nextSerialized: string): void {
        const doc = this.getActiveDoc()
        if (!doc || !nextSerialized) {
            return
        }
        if (this.topologyHistoryDocId !== doc.id) {
            this.topologyHistoryDocId = doc.id
            this.topologyUndoStack = []
            this.topologyRedoStack = []
            this.topologyLastCommittedSerialized = nextSerialized
            this.captureTopologyRestorePoint(doc.id, nextSerialized, true)
            return
        }
        if (!this.topologyLastCommittedSerialized) {
            this.topologyLastCommittedSerialized = nextSerialized
            this.captureTopologyRestorePoint(doc.id, nextSerialized, true)
            return
        }
        if (this.topologyLastCommittedSerialized === nextSerialized) {
            return
        }
        if (!this.topologyApplyingUndoRedo) {
            this.pushTopologyUndoState(this.topologyLastCommittedSerialized)
            this.topologyRedoStack = []
            this.captureTopologyRestorePoint(doc.id, nextSerialized)
        }
        this.topologyLastCommittedSerialized = nextSerialized
    }

    private applyTopologySnapshot (serialized: string, fromUndoRedo: boolean): void {
        const doc = this.getActiveDoc()
        if (!doc) {
            return
        }
        try {
            const parsed = JSON.parse(serialized)
            this.topologyData = this.normalizeTopologyData(parsed, doc.name || 'topology.json')
            this.clearTopologySelection()
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
            this.resetTopologyResizeState()
            this.topologyFreeLinkPlacementDirected = null
            this.resetTopologyFreeLinkDraftState()
            this.cancelTopologyFreeLinkHandleDrag()
            this.topologyTextPlacementMode = false
            this.topologyStickyNotePlacementMode = false
            this.topologyParseError = ''
            this.topologyApplyingUndoRedo = fromUndoRedo
            this.persistTopologyToDoc()
        } catch (err: any) {
            this.setError(`Failed to apply topology snapshot: ${err?.message ?? err}`)
        } finally {
            this.topologyApplyingUndoRedo = false
            this.cdr.markForCheck()
        }
    }

    private adjustTopologyZoom (scaleFactor: number, anchorClientX?: number, anchorClientY?: number): void {
        if (!this.topologyCanvas?.nativeElement || !Number.isFinite(scaleFactor) || scaleFactor <= 0) {
            return
        }
        const canvas = this.topologyCanvas.nativeElement
        const rect = canvas.getBoundingClientRect()
        const oldZoom = Math.max(0.1, this.topologyZoom || 1)
        const nextZoom = Math.max(0.3, Math.min(3.5, oldZoom * scaleFactor))
        if (Math.abs(nextZoom - oldZoom) < 0.0001) {
            return
        }
        const rawX = anchorClientX == null ? rect.width / 2 : (anchorClientX - rect.left)
        const rawY = anchorClientY == null ? rect.height / 2 : (anchorClientY - rect.top)
        const worldX = (rawX - this.topologyPanX) / oldZoom
        const worldY = (rawY - this.topologyPanY) / oldZoom
        this.topologyZoom = nextZoom
        this.topologyPanX = Math.round(rawX - worldX * nextZoom)
        this.topologyPanY = Math.round(rawY - worldY * nextZoom)
        this.clearTopologyPointerSpaceCache()
        this.cdr.markForCheck()
    }

    private beginTopologyPanDrag (event: MouseEvent, clearSelectionOnClick = false): void {
        if (!this.topologyCanvasMode) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        this.topologyPanDragActive = true
        this.topologyPanDragStartX = event.clientX
        this.topologyPanDragStartY = event.clientY
        this.topologyPanDragOriginX = this.topologyPanX
        this.topologyPanDragOriginY = this.topologyPanY
        this.topologyPanDragMoved = false
        this.topologyPanClearSelectionOnClick = clearSelectionOnClick
        this.clearTopologyPointerSpaceCache()
    }

    private updateTopologyPanDrag (event: MouseEvent): boolean {
        if (!this.topologyPanDragActive) {
            return false
        }
        const dx = event.clientX - this.topologyPanDragStartX
        const dy = event.clientY - this.topologyPanDragStartY
        const nextX = Math.round(this.topologyPanDragOriginX + dx)
        const nextY = Math.round(this.topologyPanDragOriginY + dy)
        if (nextX === this.topologyPanX && nextY === this.topologyPanY) {
            return false
        }
        this.topologyPanX = nextX
        this.topologyPanY = nextY
        this.topologyPanDragMoved = true
        this.clearTopologyPointerSpaceCache()
        this.scheduleTopologyRender()
        return true
    }

    private finishTopologyPanDrag (): void {
        if (!this.topologyPanDragActive) {
            return
        }
        const clearSelection = this.topologyPanClearSelectionOnClick && !this.topologyPanDragMoved
        this.topologyPanDragActive = false
        this.topologyPanDragMoved = false
        this.topologyPanClearSelectionOnClick = false
        this.clearTopologyPointerSpaceCache()
        if (clearSelection) {
            this.clearTopologySelection()
            this.cdr.markForCheck()
        }
    }

    private beginTopologyMarqueeDrag (event: MouseEvent): void {
        this.captureTopologyPointerSpaceCache()
        const cache = this.topologyPointerSpaceCache
        if (!cache) {
            return
        }
        this.topologyMarqueeStartRawX = event.clientX - cache.left
        this.topologyMarqueeStartRawY = event.clientY - cache.top
        this.topologyMarqueeCurrentRawX = this.topologyMarqueeStartRawX
        this.topologyMarqueeCurrentRawY = this.topologyMarqueeStartRawY
        this.topologyMarqueeActive = true
        this.topologyMarqueeMoved = false
        this.topologyMarqueeAppendSelection = event.metaKey || event.ctrlKey || event.shiftKey
        this.topologyMarqueeSeedNodeIds = new Set(this.topologySelectedNodeIds)
        this.topologyMarqueeSeedLinkIds = new Set(this.topologySelectedLinkIds)
        this.topologyMarqueeSeedShapeIds = new Set(this.topologySelectedShapeIds)
        this.topologyMarqueeSeedTextIds = new Set(this.topologySelectedTextIds)
        this.topologyMarqueeLeftPx = this.topologyMarqueeStartRawX
        this.topologyMarqueeTopPx = this.topologyMarqueeStartRawY
        this.topologyMarqueeWidthPx = 0
        this.topologyMarqueeHeightPx = 0
    }

    private updateTopologyMarquee (event: MouseEvent): boolean {
        if (!this.topologyMarqueeActive || !this.topologyData) {
            return false
        }
        if (!this.topologyPointerSpaceCache) {
            this.captureTopologyPointerSpaceCache()
        }
        const cache = this.topologyPointerSpaceCache
        if (!cache) {
            return false
        }
        this.topologyMarqueeCurrentRawX = event.clientX - cache.left
        this.topologyMarqueeCurrentRawY = event.clientY - cache.top
        this.topologyMarqueeLeftPx = Math.min(this.topologyMarqueeStartRawX, this.topologyMarqueeCurrentRawX)
        this.topologyMarqueeTopPx = Math.min(this.topologyMarqueeStartRawY, this.topologyMarqueeCurrentRawY)
        this.topologyMarqueeWidthPx = Math.abs(this.topologyMarqueeCurrentRawX - this.topologyMarqueeStartRawX)
        this.topologyMarqueeHeightPx = Math.abs(this.topologyMarqueeCurrentRawY - this.topologyMarqueeStartRawY)
        this.topologyMarqueeMoved = this.topologyMarqueeMoved || this.topologyMarqueeWidthPx >= 3 || this.topologyMarqueeHeightPx >= 3

        const zoom = Math.max(0.1, this.topologyZoom || 1)
        const minX = (this.topologyMarqueeLeftPx - this.topologyPanX) / zoom
        const maxX = ((this.topologyMarqueeLeftPx + this.topologyMarqueeWidthPx) - this.topologyPanX) / zoom
        const minY = (this.topologyMarqueeTopPx - this.topologyPanY) / zoom
        const maxY = ((this.topologyMarqueeTopPx + this.topologyMarqueeHeightPx) - this.topologyPanY) / zoom

        const nextNodeIds = new Set(this.topologyMarqueeAppendSelection ? this.topologyMarqueeSeedNodeIds : [])
        for (const node of this.topologyData.nodes) {
            const size = this.getTopologyNodeSize(node)
            const intersects = !(node.x + size.width < minX || node.x > maxX || node.y + size.height < minY || node.y > maxY)
            if (intersects) {
                nextNodeIds.add(node.id)
            }
        }

        const nextTextIds = new Set(this.topologyMarqueeAppendSelection ? this.topologyMarqueeSeedTextIds : [])
        for (const item of this.topologyData.texts) {
            const size = this.getTopologyStickyNoteSize(item)
            const intersects = item.sticky
                ? !(item.x + size.width < minX || item.x > maxX || item.y + size.height < minY || item.y > maxY)
                : (item.x >= minX && item.x <= maxX && item.y >= minY && item.y <= maxY)
            if (intersects) {
                nextTextIds.add(item.id)
            }
        }

        const nextShapeIds = new Set(this.topologyMarqueeAppendSelection ? this.topologyMarqueeSeedShapeIds : [])
        for (const shape of this.topologyData.shapes) {
            const intersects = !(shape.x + shape.width < minX || shape.x > maxX || shape.y + shape.height < minY || shape.y > maxY)
            if (intersects) {
                nextShapeIds.add(shape.id)
            }
        }

        const nextLinkIds = new Set(this.topologyMarqueeAppendSelection ? this.topologyMarqueeSeedLinkIds : [])
        for (const renderItem of this.topologyLinkRenderItems) {
            const labelInside = renderItem.labels.some(label =>
                label.labelX >= minX &&
                label.labelX <= maxX &&
                label.labelY >= minY &&
                label.labelY <= maxY,
            )
            if (labelInside) {
                nextLinkIds.add(renderItem.id)
            }
        }

        this.topologySelectedNodeIds = nextNodeIds
        this.topologySelectedLinkIds = nextLinkIds
        this.topologySelectedShapeIds = nextShapeIds
        this.topologySelectedTextIds = nextTextIds
        this.syncTopologyPrimarySelectionFromSets()
        this.scheduleTopologyRender()
        return true
    }

    private finishTopologyMarquee (): void {
        if (!this.topologyMarqueeActive) {
            return
        }
        this.topologyMarqueeActive = false
        this.topologyMarqueeWidthPx = 0
        this.topologyMarqueeHeightPx = 0
        this.topologyMarqueeMoved = false
        this.topologyMarqueeAppendSelection = false
        this.topologyMarqueeSeedNodeIds.clear()
        this.topologyMarqueeSeedLinkIds.clear()
        this.topologyMarqueeSeedShapeIds.clear()
        this.topologyMarqueeSeedTextIds.clear()
        this.clearTopologyPointerSpaceCache()
        this.cdr.markForCheck()
    }

    private getTopologyNodeCenter (node: TopologyNodeModel): { x: number, y: number } {
        const nodeSize = this.getTopologyNodeSize(node)
        return {
            x: node.x + nodeSize.width / 2,
            y: node.y + nodeSize.height / 2,
        }
    }

    private getTopologyShapeSize (shape: TopologyShapeModel): { width: number, height: number } {
        return {
            width: Math.max(20, Math.min(560, Number(shape.width) || 96)),
            height: Math.max(20, Math.min(560, Number(shape.height) || 96)),
        }
    }

    private getTopologyShapeCenter (shape: TopologyShapeModel): { x: number, y: number } {
        const size = this.getTopologyShapeSize(shape)
        return {
            x: shape.x + size.width / 2,
            y: shape.y + size.height / 2,
        }
    }

    private getTopologyNodeEdgePoint (node: TopologyNodeModel, targetX: number, targetY: number, gap = 0): { x: number, y: number } {
        const nodeSize = this.getTopologyNodeSize(node)
        const halfW = nodeSize.width / 2
        const halfH = nodeSize.height / 2
        const center = this.getTopologyNodeCenter(node)
        const cx = center.x
        const cy = center.y
        const tx = targetX
        const ty = targetY
        const dx = tx - cx
        const dy = ty - cy
        const absDx = Math.abs(dx)
        const absDy = Math.abs(dy)
        if (absDx < 0.001 && absDy < 0.001) {
            return { x: cx, y: cy }
        }
        const scaleX = absDx > 0.001 ? halfW / absDx : Number.POSITIVE_INFINITY
        const scaleY = absDy > 0.001 ? halfH / absDy : Number.POSITIVE_INFINITY
        const scale = Math.min(scaleX, scaleY)
        const length = Math.hypot(dx, dy)
        const ux = length > 0.001 ? dx / length : 0
        const uy = length > 0.001 ? dy / length : 0
        return {
            x: cx + dx * scale + ux * gap,
            y: cy + dy * scale + uy * gap,
        }
    }

    private getTopologyShapeEdgePoint (shape: TopologyShapeModel, targetX: number, targetY: number, gap = 0): { x: number, y: number } {
        const size = this.getTopologyShapeSize(shape)
        const center = this.getTopologyShapeCenter(shape)
        const cx = center.x
        const cy = center.y
        const dx = targetX - cx
        const dy = targetY - cy
        if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
            return { x: cx, y: cy }
        }
        const rx = Math.max(1, size.width / 2)
        const ry = Math.max(1, size.height / 2)
        const denom = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry))
        const scale = denom > 0.0001 ? 1 / denom : 0
        const baseX = cx + dx * scale
        const baseY = cy + dy * scale
        const len = Math.hypot(dx, dy)
        const ux = len > 0.001 ? dx / len : 0
        const uy = len > 0.001 ? dy / len : 0
        return {
            x: baseX + ux * gap,
            y: baseY + uy * gap,
        }
    }

    private resolveTopologyLinkEndpointKind (
        requestedKind: unknown,
        id: string|undefined,
        nodeById: Map<string, TopologyNodeModel>,
        shapeById: Map<string, TopologyShapeModel>,
    ): TopologyLinkEndpointKind|null {
        if (!id) {
            return null
        }
        const kind: TopologyLinkEndpointKind = requestedKind === 'shape' ? 'shape' : 'node'
        const hasNode = nodeById.has(id)
        const hasShape = shapeById.has(id)
        if (!hasNode && !hasShape) {
            return null
        }
        if (kind === 'shape') {
            if (hasShape) {
                return 'shape'
            }
            return hasNode ? 'node' : null
        }
        if (hasNode) {
            return 'node'
        }
        return hasShape ? 'shape' : null
    }

    private normalizeTopologyHexColor (value: unknown): string|null {
        if (typeof value !== 'string') {
            return null
        }
        const raw = value.trim()
        const short = raw.match(/^#([0-9a-fA-F]{3})$/)
        if (short) {
            const r = short[1][0]
            const g = short[1][1]
            const b = short[1][2]
            return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
        }
        const long = raw.match(/^#([0-9a-fA-F]{6})$/)
        if (long) {
            return `#${long[1]}`.toLowerCase()
        }
        return null
    }

    private getTopologyColorOptions (selectedColor: string, palette: TopologyColorOption[] = this.topologyColorPalette): TopologyColorOption[] {
        const normalized = this.normalizeTopologyHexColor(selectedColor)
        if (!normalized) {
            return palette
        }
        if (palette.some(x => x.value === normalized)) {
            return palette
        }
        return [
            { label: `Current (${normalized})`, value: normalized },
            ...palette,
        ]
    }

    private getTopologyReadableTextColor (background: string, darkColor: string, lightColor: string): string {
        const hex = this.normalizeTopologyHexColor(background)
        if (!hex) {
            return darkColor
        }
        const r = Number.parseInt(hex.slice(1, 3), 16) / 255
        const g = Number.parseInt(hex.slice(3, 5), 16) / 255
        const b = Number.parseInt(hex.slice(5, 7), 16) / 255
        const toLinear = (value: number): number => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
        const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
        return luminance > 0.5 ? darkColor : lightColor
    }

    private getTopologySelectionColorValue (kind: 'node'|'link'|'shape'): string {
        if (!this.topologyData) {
            return ''
        }
        if (kind === 'node') {
            if (!this.topologySelectedNodeIds.size) {
                return this.selectedTopologyNodeColor
            }
            const colors = new Set<string>()
            for (const node of this.topologyData.nodes) {
                if (!this.topologySelectedNodeIds.has(node.id)) {
                    continue
                }
                colors.add(this.normalizeTopologyHexColor(node.color) ?? this.getTopologyDefaultNodeColor())
            }
            if (colors.size === 1) {
                return colors.values().next().value ?? ''
            }
            return ''
        }
        if (kind === 'shape') {
            if (!this.topologySelectedShapeIds.size) {
                return this.selectedTopologyShapeColor
            }
            const colors = new Set<string>()
            for (const shape of this.topologyData.shapes) {
                if (!this.topologySelectedShapeIds.has(shape.id)) {
                    continue
                }
                colors.add(this.normalizeTopologyHexColor(shape.color) ?? this.getTopologyDefaultShapeColor())
            }
            if (colors.size === 1) {
                return colors.values().next().value ?? ''
            }
            return ''
        }

        if (!this.topologySelectedLinkIds.size) {
            return this.selectedTopologyLinkColor
        }
        const colors = new Set<string>()
        for (const link of this.topologyData.links) {
            if (!this.topologySelectedLinkIds.has(link.id)) {
                continue
            }
            colors.add(this.normalizeTopologyHexColor(link.color) ?? this.getTopologyDefaultLinkColor())
        }
        if (colors.size === 1) {
            return colors.values().next().value ?? ''
        }
        return ''
    }

    private getTopologyDefaultNodeColor (): string {
        return this.platform.getTheme() === 'dark' ? '#8ec5ff' : '#2563eb'
    }

    private getTopologyDefaultLinkColor (): string {
        return this.platform.getTheme() === 'dark' ? '#8ec5ff' : '#2563eb'
    }

    private getTopologyDefaultShapeColor (): string {
        return this.platform.getTheme() === 'dark' ? '#8ec5ff' : '#2563eb'
    }

    private getTopologyDefaultTextColor (): string {
        return this.platform.getTheme() === 'dark' ? '#dbeafe' : '#1d4ed8'
    }

    private getTopologyDefaultStickyNoteColor (): string {
        return '#fde68a'
    }

    private getTopologyLinkLabelLocalOffsets (
        label: TopologyLinkLabelModel,
        dirX: number,
        dirY: number,
        normalX: number,
        normalY: number,
    ): { along: number, normal: number } {
        const along = Number(label.offsetAlong)
        const normal = Number(label.offsetNormal)
        if (Number.isFinite(along) || Number.isFinite(normal)) {
            return {
                along: Number.isFinite(along) ? along : 0,
                normal: Number.isFinite(normal) ? normal : 0,
            }
        }
        const offsetX = Number(label.offsetX)
        const offsetY = Number(label.offsetY)
        const worldX = Number.isFinite(offsetX) ? offsetX : 0
        const worldY = Number.isFinite(offsetY) ? offsetY : 0
        return {
            along: worldX * dirX + worldY * dirY,
            normal: worldX * normalX + worldY * normalY,
        }
    }

    private getTopologyLinkLabels (link: TopologyLinkModel): TopologyLinkLabelModel[] {
        const existing = Array.isArray(link.labels) ? link.labels : null
        if (existing) {
            let valid = true
            const seen = new Set<string>()
            for (const entry of existing) {
                if (!entry || typeof entry !== 'object') {
                    valid = false
                    break
                }
                const id = typeof entry.id === 'string' ? entry.id.trim() : ''
                if (!id || seen.has(id)) {
                    valid = false
                    break
                }
                if (typeof entry.text !== 'string') {
                    valid = false
                    break
                }
                if (entry.offsetX != null && !Number.isFinite(Number(entry.offsetX))) {
                    valid = false
                    break
                }
                if (entry.offsetY != null && !Number.isFinite(Number(entry.offsetY))) {
                    valid = false
                    break
                }
                if (entry.offsetAlong != null && !Number.isFinite(Number(entry.offsetAlong))) {
                    valid = false
                    break
                }
                if (entry.offsetNormal != null && !Number.isFinite(Number(entry.offsetNormal))) {
                    valid = false
                    break
                }
                seen.add(id)
            }
            if (valid) {
                this.syncTopologyLegacyLinkLabelFields(link)
                return existing
            }
        }

        const used = new Set<string>()
        const labels: TopologyLinkLabelModel[] = []
        if (existing) {
            for (const rawLabel of existing) {
                if (!rawLabel || typeof rawLabel !== 'object') {
                    continue
                }
                const text = typeof rawLabel.text === 'string' ? rawLabel.text : ''
                const idCandidate = String((rawLabel as any).id ?? '').trim()
                const id = idCandidate && !used.has(idCandidate)
                    ? idCandidate
                    : this.createUniqueTopologyLinkLabelId(link, used)
                used.add(id)
                labels.push({
                    id,
                    text,
                    offsetX: Number.isFinite(Number((rawLabel as any).offsetX)) ? Number((rawLabel as any).offsetX) : undefined,
                    offsetY: Number.isFinite(Number((rawLabel as any).offsetY)) ? Number((rawLabel as any).offsetY) : undefined,
                    offsetAlong: Number.isFinite(Number((rawLabel as any).offsetAlong)) ? Number((rawLabel as any).offsetAlong) : undefined,
                    offsetNormal: Number.isFinite(Number((rawLabel as any).offsetNormal)) ? Number((rawLabel as any).offsetNormal) : undefined,
                })
            }
        }
        if (!labels.length) {
            const legacyText = typeof link.label === 'string' ? link.label : ''
            const legacyOffsetX = Number.isFinite(Number(link.labelOffsetX)) ? Number(link.labelOffsetX) : undefined
            const legacyOffsetY = Number.isFinite(Number(link.labelOffsetY)) ? Number(link.labelOffsetY) : undefined
            if (legacyText || legacyOffsetX != null || legacyOffsetY != null) {
                const id = this.createUniqueTopologyLinkLabelId(link, used)
                labels.push({
                    id,
                    text: legacyText,
                    offsetX: legacyOffsetX,
                    offsetY: legacyOffsetY,
                })
            }
        }
        link.labels = labels
        this.syncTopologyLegacyLinkLabelFields(link)
        return labels
    }

    private createUniqueTopologyLinkLabelId (link: Pick<TopologyLinkModel, 'id'|'labels'>, used?: Set<string>): string {
        const reserved = used ? new Set(used) : new Set<string>()
        for (const label of link.labels ?? []) {
            if (label?.id) {
                reserved.add(label.id)
            }
        }
        let index = 1
        while (index < 10000) {
            const candidate = `${link.id}-label-${index}`
            if (!reserved.has(candidate)) {
                return candidate
            }
            index++
        }
        return `${link.id}-label-${Date.now()}`
    }

    private syncTopologyLegacyLinkLabelFields (link: TopologyLinkModel): void {
        const labels = Array.isArray(link.labels) ? link.labels : []
        const primary = labels[0]
        if (!primary) {
            link.label = ''
            link.labelOffsetX = undefined
            link.labelOffsetY = undefined
            return
        }
        link.label = primary.text ?? ''
        const legacyX = Number.isFinite(Number(primary.offsetX))
            ? Number(primary.offsetX)
            : (Number.isFinite(Number(primary.offsetAlong)) ? Number(primary.offsetAlong) : undefined)
        const legacyY = Number.isFinite(Number(primary.offsetY))
            ? Number(primary.offsetY)
            : (Number.isFinite(Number(primary.offsetNormal)) ? Number(primary.offsetNormal) : undefined)
        link.labelOffsetX = legacyX
        link.labelOffsetY = legacyY
    }

    getTopologyPrimaryLinkLabel (link: TopologyLinkModel): TopologyLinkLabelModel|null {
        const labels = this.getTopologyLinkLabels(link)
        return labels[0] ?? null
    }

    private addTopologyLinkLabel (
        link: TopologyLinkModel,
        anchorX?: number|null,
        anchorY?: number|null,
        initialText = '',
    ): TopologyLinkLabelModel {
        const renderItem = this.topologyLinkRenderItems.find(item => item.id === link.id)
        const labels = this.getTopologyLinkLabels(link)
        const referenceLabel = renderItem?.labels[0]
        const baseX = referenceLabel?.baseLabelX ?? renderItem?.baseLabelX
        const baseY = referenceLabel?.baseLabelY ?? renderItem?.baseLabelY
        const dirX = renderItem?.dirX ?? 1
        const dirY = renderItem?.dirY ?? 0
        const normalX = renderItem?.normalX ?? 0
        const normalY = renderItem?.normalY ?? 1
        const nextLabel: TopologyLinkLabelModel = {
            id: this.createUniqueTopologyLinkLabelId(link),
            text: initialText,
            offsetAlong: undefined,
            offsetNormal: undefined,
            offsetX: undefined,
            offsetY: undefined,
        }
        if (Number.isFinite(Number(anchorX)) && Number.isFinite(Number(anchorY)) && baseX != null && baseY != null) {
            const dx = Number(anchorX) - baseX
            const dy = Number(anchorY) - baseY
            nextLabel.offsetAlong = Number((dx * dirX + dy * dirY).toFixed(2))
            nextLabel.offsetNormal = Number((dx * normalX + dy * normalY).toFixed(2))
        } else if (labels.length > 0) {
            nextLabel.offsetAlong = labels.length * 6
            nextLabel.offsetNormal = labels.length * 18
        }
        const nextOffsetX = (nextLabel.offsetAlong ?? 0) * dirX + (nextLabel.offsetNormal ?? 0) * normalX
        const nextOffsetY = (nextLabel.offsetAlong ?? 0) * dirY + (nextLabel.offsetNormal ?? 0) * normalY
        nextLabel.offsetX = Number(nextOffsetX.toFixed(2))
        nextLabel.offsetY = Number(nextOffsetY.toFixed(2))
        if (baseX != null && baseY != null && renderItem) {
            const existingPositions = renderItem.labels.map(item => ({ x: item.labelX, y: item.labelY }))
            let labelX = baseX + ((nextLabel.offsetAlong ?? 0) * dirX + (nextLabel.offsetNormal ?? 0) * normalX)
            let labelY = baseY + ((nextLabel.offsetAlong ?? 0) * dirY + (nextLabel.offsetNormal ?? 0) * normalY)
            let guard = 0
            while (guard < 40 && existingPositions.some(item => Math.abs(item.x - labelX) < 24 && Math.abs(item.y - labelY) < 14)) {
                nextLabel.offsetAlong = Number(((nextLabel.offsetAlong ?? 0) + 6).toFixed(2))
                nextLabel.offsetNormal = Number(((nextLabel.offsetNormal ?? 0) + 18).toFixed(2))
                nextLabel.offsetX = Number((((nextLabel.offsetAlong ?? 0) * dirX + (nextLabel.offsetNormal ?? 0) * normalX).toFixed(2)))
                nextLabel.offsetY = Number((((nextLabel.offsetAlong ?? 0) * dirY + (nextLabel.offsetNormal ?? 0) * normalY).toFixed(2)))
                labelX = baseX + ((nextLabel.offsetAlong ?? 0) * dirX + (nextLabel.offsetNormal ?? 0) * normalX)
                labelY = baseY + ((nextLabel.offsetAlong ?? 0) * dirY + (nextLabel.offsetNormal ?? 0) * normalY)
                guard++
            }
        }
        labels.push(nextLabel)
        this.syncTopologyLegacyLinkLabelFields(link)
        return nextLabel
    }

    private getTopologyLinkStyle (link: Pick<TopologyLinkModel, 'directed'|'bidirectional'>|null|undefined): TopologyLinkStyle {
        if (link?.bidirectional === true) {
            return 'double'
        }
        return link?.directed === false ? 'line' : 'arrow'
    }

    private applyTopologyLinkStyle (link: TopologyLinkModel, style: TopologyLinkStyle): boolean {
        const nextDirected = style !== 'line'
        const nextBidirectional = style === 'double'
        let changed = false
        if ((link.directed !== false) !== nextDirected) {
            link.directed = nextDirected
            changed = true
        }
        if ((link.bidirectional === true) !== nextBidirectional) {
            link.bidirectional = nextBidirectional
            changed = true
        }
        return changed
    }

    private getNextTopologyLinkStyle (style: TopologyLinkStyle): TopologyLinkStyle {
        if (style === 'line') {
            return 'arrow'
        }
        if (style === 'arrow') {
            return 'double'
        }
        return 'line'
    }

    private isTopologyDocCandidate (doc: EditorDocument): boolean {
        const lowerName = (doc.name || '').toLowerCase()
        if (lowerName.endsWith('.topology.json')) {
            return true
        }
        if (!lowerName.endsWith('.json') || !this.isModelAlive(doc)) {
            return false
        }
        const content = doc.model.getValue()
        if (!content || (!content.includes('"nodes"') && !content.includes('"tlink-topology"'))) {
            return false
        }
        try {
            const parsed = JSON.parse(content)
            return !!parsed && typeof parsed === 'object' &&
                (parsed.type === 'tlink-topology' || (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)))
        } catch {
            return false
        }
    }

    private normalizeTopologyData (raw: any, fileName: string): TopologyDocumentModel {
        const parsedNodes = Array.isArray(raw?.nodes) ? raw.nodes : []
        const parsedLinks = Array.isArray(raw?.links) ? raw.links : []
        const parsedShapes = Array.isArray(raw?.shapes) ? raw.shapes : []
        const parsedTexts = Array.isArray(raw?.texts) ? raw.texts : []
        const nodes: TopologyNodeModel[] = []
        const links: TopologyLinkModel[] = []
        const shapes: TopologyShapeModel[] = []
        const texts: TopologyTextModel[] = []
        for (const entry of parsedNodes) {
            if (!entry || typeof entry !== 'object') {
                continue
            }
            const id = String(entry.id ?? '').trim()
            if (!id) {
                continue
            }
            const widthRaw = Number(entry.width)
            const heightRaw = Number(entry.height)
            const width = Math.max(80, Math.min(560, Number.isFinite(widthRaw) ? widthRaw : this.topologyNodeWidthPx))
            const height = Math.max(56, Math.min(320, Number.isFinite(heightRaw) ? heightRaw : this.topologyNodeHeightPx))
            nodes.push({
                id,
                type: String(entry.type ?? 'node'),
                label: String(entry.label ?? id),
                x: Number.isFinite(Number(entry.x)) ? Number(entry.x) : 20,
                y: Number.isFinite(Number(entry.y)) ? Number(entry.y) : 20,
                width,
                height,
                color: this.normalizeTopologyHexColor(entry.color) ?? this.getTopologyDefaultNodeColor(),
            })
        }
        const nodeIds = new Set(nodes.map(x => x.id))
        const shapeIds = new Set<string>()
        for (const entry of parsedShapes) {
            if (!entry || typeof entry !== 'object') {
                continue
            }
            const id = String(entry.id ?? '').trim()
            if (!id) {
                continue
            }
            shapeIds.add(id)
        }
        for (const entry of parsedLinks) {
            if (!entry || typeof entry !== 'object') {
                continue
            }
            const id = String(entry.id ?? '').trim()
            const from = String(entry.from ?? '').trim()
            const to = String(entry.to ?? '').trim()
            const requestedFromKind: TopologyLinkEndpointKind = String(entry.fromKind ?? 'node').toLowerCase() === 'shape' ? 'shape' : 'node'
            const requestedToKind: TopologyLinkEndpointKind = String(entry.toKind ?? 'node').toLowerCase() === 'shape' ? 'shape' : 'node'
            let fromKind: TopologyLinkEndpointKind|null = null
            let toKind: TopologyLinkEndpointKind|null = null
            if (from) {
                if (requestedFromKind === 'shape') {
                    fromKind = shapeIds.has(from) ? 'shape' : (nodeIds.has(from) ? 'node' : null)
                } else {
                    fromKind = nodeIds.has(from) ? 'node' : (shapeIds.has(from) ? 'shape' : null)
                }
            }
            if (to) {
                if (requestedToKind === 'shape') {
                    toKind = shapeIds.has(to) ? 'shape' : (nodeIds.has(to) ? 'node' : null)
                } else {
                    toKind = nodeIds.has(to) ? 'node' : (shapeIds.has(to) ? 'shape' : null)
                }
            }
            const hasEndpointRefs = !!from && !!to && !!fromKind && !!toKind
            const x1 = Number(entry.x1)
            const y1 = Number(entry.y1)
            const x2 = Number(entry.x2)
            const y2 = Number(entry.y2)
            const hasFreePoints = [x1, y1, x2, y2].every(Number.isFinite)
            if (!id || (!hasEndpointRefs && !hasFreePoints)) {
                continue
            }
            const normalizedLabels: TopologyLinkLabelModel[] = []
            if (Array.isArray(entry.labels)) {
                const usedLabelIds = new Set<string>()
                for (const labelEntry of entry.labels) {
                    if (!labelEntry || typeof labelEntry !== 'object') {
                        continue
                    }
                    const text = typeof labelEntry.text === 'string' ? labelEntry.text : ''
                    const idCandidate = String((labelEntry as any).id ?? '').trim()
                    const labelId = idCandidate && !usedLabelIds.has(idCandidate)
                        ? idCandidate
                        : `${id}-label-${usedLabelIds.size + 1}`
                    usedLabelIds.add(labelId)
                    normalizedLabels.push({
                        id: labelId,
                        text,
                        offsetX: Number.isFinite(Number((labelEntry as any).offsetX)) ? Number((labelEntry as any).offsetX) : undefined,
                        offsetY: Number.isFinite(Number((labelEntry as any).offsetY)) ? Number((labelEntry as any).offsetY) : undefined,
                        offsetAlong: Number.isFinite(Number((labelEntry as any).offsetAlong)) ? Number((labelEntry as any).offsetAlong) : undefined,
                        offsetNormal: Number.isFinite(Number((labelEntry as any).offsetNormal)) ? Number((labelEntry as any).offsetNormal) : undefined,
                    })
                }
            } else {
                const legacyText = typeof entry.label === 'string' ? entry.label : ''
                const legacyOffsetX = Number.isFinite(Number(entry.labelOffsetX)) ? Number(entry.labelOffsetX) : undefined
                const legacyOffsetY = Number.isFinite(Number(entry.labelOffsetY)) ? Number(entry.labelOffsetY) : undefined
                if (legacyText || legacyOffsetX != null || legacyOffsetY != null) {
                    normalizedLabels.push({
                        id: `${id}-label-1`,
                        text: legacyText,
                        offsetX: legacyOffsetX,
                        offsetY: legacyOffsetY,
                    })
                }
            }
            const link: TopologyLinkModel = {
                id,
                from: hasEndpointRefs ? from : undefined,
                to: hasEndpointRefs ? to : undefined,
                fromKind: hasEndpointRefs ? fromKind ?? undefined : undefined,
                toKind: hasEndpointRefs ? toKind ?? undefined : undefined,
                x1: hasEndpointRefs ? undefined : x1,
                y1: hasEndpointRefs ? undefined : y1,
                x2: hasEndpointRefs ? undefined : x2,
                y2: hasEndpointRefs ? undefined : y2,
                label: typeof entry.label === 'string' ? entry.label : '',
                labelOffsetX: Number.isFinite(Number(entry.labelOffsetX)) ? Number(entry.labelOffsetX) : undefined,
                labelOffsetY: Number.isFinite(Number(entry.labelOffsetY)) ? Number(entry.labelOffsetY) : undefined,
                labels: normalizedLabels,
                color: this.normalizeTopologyHexColor(entry.color) ?? this.getTopologyDefaultLinkColor(),
                directed: entry.directed !== false || entry.bidirectional === true,
                bidirectional: entry.bidirectional === true,
            }
            this.syncTopologyLegacyLinkLabelFields(link)
            links.push(link)
        }
        for (const entry of parsedShapes) {
            if (!entry || typeof entry !== 'object') {
                continue
            }
            const id = String(entry.id ?? '').trim()
            if (!id) {
                continue
            }
            const kind = String(entry.kind ?? 'oval').toLowerCase() === 'circle' ? 'circle' : 'oval'
            const widthRaw = Number(entry.width)
            const heightRaw = Number(entry.height)
            const width = Math.max(20, Math.min(560, Number.isFinite(widthRaw) ? widthRaw : (kind === 'circle' ? 96 : 148)))
            const height = Math.max(20, Math.min(560, Number.isFinite(heightRaw) ? heightRaw : 96))
            shapes.push({
                id,
                kind,
                x: Number.isFinite(Number(entry.x)) ? Number(entry.x) : 28,
                y: Number.isFinite(Number(entry.y)) ? Number(entry.y) : 28,
                width: kind === 'circle' ? width : width,
                height: kind === 'circle' ? width : height,
                label: typeof entry.label === 'string' ? entry.label : '',
                color: this.normalizeTopologyHexColor(entry.color) ?? this.getTopologyDefaultShapeColor(),
            })
        }
        for (const entry of parsedTexts) {
            if (!entry || typeof entry !== 'object') {
                continue
            }
            const id = String(entry.id ?? '').trim()
            if (!id) {
                continue
            }
            const sticky = entry.sticky === true
            const widthRaw = Number(entry.width)
            const heightRaw = Number(entry.height)
            const stickyWidth = Number.isFinite(widthRaw) ? Math.max(100, widthRaw) : undefined
            const stickyHeight = Number.isFinite(heightRaw) ? Math.max(64, heightRaw) : undefined
            texts.push({
                id,
                text: String(entry.text ?? ''),
                x: Number.isFinite(Number(entry.x)) ? Number(entry.x) : 20,
                y: Number.isFinite(Number(entry.y)) ? Number(entry.y) : 20,
                sticky,
                collapsed: sticky ? entry.collapsed === true : false,
                width: sticky ? stickyWidth : undefined,
                height: sticky ? stickyHeight : undefined,
                color: this.normalizeTopologyHexColor(entry.color) ?? (sticky ? this.getTopologyDefaultStickyNoteColor() : this.getTopologyDefaultTextColor()),
            })
        }
        const nameFromFile = path.basename(fileName, path.extname(fileName))
        return {
            ...(raw && typeof raw === 'object' ? raw : {}),
            schemaVersion: String(raw?.schemaVersion ?? '1.0'),
            type: 'tlink-topology',
            name: String(raw?.name ?? nameFromFile),
            nodes,
            links,
            shapes,
            texts,
            metadata: raw?.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
        }
    }

    private applyTopologyViewSettingsFromMetadata (): void {
        const metadata = this.topologyData?.metadata
        if (!metadata || typeof metadata !== 'object') {
            this.topologyCurvedLinks = true
            this.topologyNewLinksDirected = false
            return
        }
        const editorMeta = (metadata as any).editor
        const curved = editorMeta?.linksCurved ?? (metadata as any).linksCurved
        const directed = editorMeta?.newLinksDirected ?? (metadata as any).newLinksDirected
        this.topologyCurvedLinks = typeof curved === 'boolean' ? curved : true
        this.topologyNewLinksDirected = typeof directed === 'boolean' ? directed : false
    }

    private writeTopologyViewSettingsToMetadata (): void {
        if (!this.topologyData) {
            return
        }
        const metadata = (this.topologyData.metadata && typeof this.topologyData.metadata === 'object')
            ? { ...this.topologyData.metadata }
            : {}
        const editorMetaRaw = (metadata as any).editor
        const editorMeta = (editorMetaRaw && typeof editorMetaRaw === 'object')
            ? { ...editorMetaRaw }
            : {}
        editorMeta.linksCurved = this.topologyCurvedLinks
        editorMeta.newLinksDirected = this.topologyNewLinksDirected
        ;(metadata as any).editor = editorMeta
        this.topologyData.metadata = metadata
    }

    private loadTopologyFromDoc (doc: EditorDocument): void {
        if (!this.isModelAlive(doc)) {
            this.topologyData = null
            this.topologyParseError = 'Document model is unavailable'
            this.clearTopologySelection()
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
            this.resetTopologyResizeState()
            this.topologyFreeLinkPlacementDirected = null
            this.resetTopologyFreeLinkDraftState()
            this.cancelTopologyFreeLinkHandleDrag()
            this.topologyTextPlacementMode = false
            this.topologyStickyNotePlacementMode = false
            this.topologyHistoryDocId = null
            this.topologyLastCommittedSerialized = ''
            this.topologyUndoStack = []
            this.topologyRedoStack = []
            return
        }
        try {
            const rawContent = doc.model.getValue()
            const parsed = rawContent?.trim()
                ? JSON.parse(rawContent)
                : { type: 'tlink-topology', nodes: [], links: [], shapes: [], texts: [] }
            this.topologyData = this.normalizeTopologyData(parsed, doc.name || 'topology.json')
            this.invalidateTopologyLinkRenderItems()
            this.applyTopologyViewSettingsFromMetadata()
            this.topologyParseError = ''
            this.clearTopologySelection()
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
            this.resetTopologyResizeState()
            this.topologyFreeLinkPlacementDirected = null
            this.resetTopologyFreeLinkDraftState()
            this.cancelTopologyFreeLinkHandleDrag()
            this.topologyTextPlacementMode = false
            this.topologyStickyNotePlacementMode = false
            const serialized = this.serializeTopology(this.topologyData)
            if (this.topologyHistoryDocId !== doc.id) {
                this.topologyHistoryDocId = doc.id
                this.topologyUndoStack = []
                this.topologyRedoStack = []
            }
            this.topologyLastCommittedSerialized = serialized
            this.captureTopologyRestorePoint(doc.id, serialized, true)
        } catch (err: any) {
            this.topologyData = null
            this.invalidateTopologyLinkRenderItems()
            this.clearTopologySelection()
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
            this.resetTopologyResizeState()
            this.topologyFreeLinkPlacementDirected = null
            this.resetTopologyFreeLinkDraftState()
            this.cancelTopologyFreeLinkHandleDrag()
            this.topologyTextPlacementMode = false
            this.topologyStickyNotePlacementMode = false
            this.topologyParseError = `Topology JSON parse error: ${err?.message ?? err}`
            this.topologyHistoryDocId = null
            this.topologyLastCommittedSerialized = ''
            this.topologyUndoStack = []
            this.topologyRedoStack = []
        }
    }

    private syncTopologyForActiveDoc (): void {
        if (!this.topologyCanvasMode) {
            return
        }
        const doc = this.getActiveDoc()
        if (!doc || !this.isTopologyDocCandidate(doc)) {
            this.topologyCanvasMode = false
            this.topologyData = null
            this.invalidateTopologyLinkRenderItems()
            this.topologyParseError = ''
            this.clearTopologySelection()
            this.topologyPendingLinkSourceId = null
            this.topologyPendingLinkSourceKind = null
            this.resetTopologyResizeState()
            this.topologyFreeLinkPlacementDirected = null
            this.resetTopologyFreeLinkDraftState()
            this.cancelTopologyFreeLinkHandleDrag()
            this.topologyTextPlacementMode = false
            this.topologyStickyNotePlacementMode = false
            return
        }
        if (!this.topologyWritingDoc) {
            this.loadTopologyFromDoc(doc)
        }
    }

    private createUniqueTopologyNodeId (prefix: string): string {
        const stem = (prefix || 'node').toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'node'
        const existing = new Set(this.topologyData?.nodes.map(node => node.id) ?? [])
        let index = 1
        while (index < 10000) {
            const candidate = `${stem}-${index}`
            if (!existing.has(candidate)) {
                return candidate
            }
            index++
        }
        return `${stem}-${Date.now()}`
    }

    private createUniqueTopologyLinkId (): string {
        const existing = new Set(this.topologyData?.links.map(link => link.id) ?? [])
        let index = 1
        while (index < 10000) {
            const candidate = `link-${index}`
            if (!existing.has(candidate)) {
                return candidate
            }
            index++
        }
        return `link-${Date.now()}`
    }

    private createUniqueTopologyTextId (): string {
        const existing = new Set(this.topologyData?.texts.map(item => item.id) ?? [])
        let index = 1
        while (index < 10000) {
            const candidate = `text-${index}`
            if (!existing.has(candidate)) {
                return candidate
            }
            index++
        }
        return `text-${Date.now()}`
    }

    private createUniqueTopologyShapeId (): string {
        const existing = new Set(this.topologyData?.shapes.map(item => item.id) ?? [])
        let index = 1
        while (index < 10000) {
            const candidate = `shape-${index}`
            if (!existing.has(candidate)) {
                return candidate
            }
            index++
        }
        return `shape-${Date.now()}`
    }

    private persistTopologyToDoc (): void {
        if (!this.topologyData) {
            return
        }
        const doc = this.getActiveDoc()
        if (!doc || !this.isModelAlive(doc)) {
            return
        }
        this.writeTopologyViewSettingsToMetadata()
        const serializedLinks = (this.topologyData.links ?? []).map(link => {
            const next: TopologyLinkModel = {
                ...link,
                labels: this.getTopologyLinkLabels(link).map(label => ({ ...label })),
            }
            this.syncTopologyLegacyLinkLabelFields(next)
            return next
        })
        const next: TopologyDocumentModel = {
            ...this.topologyData,
            type: 'tlink-topology',
            links: serializedLinks,
            shapes: [...(this.topologyData.shapes ?? [])],
            texts: [...(this.topologyData.texts ?? [])],
            metadata: {
                ...(this.topologyData.metadata ?? {}),
                updatedAt: new Date().toISOString(),
            },
        }
        this.commitTopologyHistoryIfChanged(this.serializeTopology(next))
        const serialized = `${JSON.stringify(next, null, 2)}\n`
        this.topologyWritingDoc = true
        try {
            doc.model.setValue(serialized)
            this.topologyData = next
            this.invalidateTopologyLinkRenderItems()
            this.topologyParseError = ''
        } finally {
            this.topologyWritingDoc = false
        }
    }

    get treeTopSpacerPx (): number {
        if (this._treeItems.length <= this.treeVirtualizationThreshold) {
            return 0
        }
        return this.treeVirtualStartIndex * this.treeVirtualRowHeightPx
    }

    get treeBottomSpacerPx (): number {
        if (this._treeItems.length <= this.treeVirtualizationThreshold) {
            return 0
        }
        return Math.max(0, (this._treeItems.length - this.treeVirtualEndIndex) * this.treeVirtualRowHeightPx)
    }

    private treeVirtualStartIndex = 0
    private treeVirtualEndIndex = 0

    private updateVisibleTreeItems (force = false): void {
        const total = this._treeItems.length
        if (!total) {
            this.treeVirtualStartIndex = 0
            this.treeVirtualEndIndex = 0
            this._visibleTreeItems = []
            return
        }

        if (total <= this.treeVirtualizationThreshold || !this.treeList?.nativeElement) {
            this.treeVirtualStartIndex = 0
            this.treeVirtualEndIndex = total
            this._visibleTreeItems = this._treeItems
            return
        }

        const container = this.treeList.nativeElement
        const viewportRows = Math.max(1, Math.ceil(container.clientHeight / this.treeVirtualRowHeightPx))
        const start = Math.max(0, Math.floor(container.scrollTop / this.treeVirtualRowHeightPx) - this.treeVirtualOverscanRows)
        const end = Math.min(total, start + viewportRows + this.treeVirtualOverscanRows * 2)

        if (!force && start === this.treeVirtualStartIndex && end === this.treeVirtualEndIndex) {
            return
        }

        this.treeVirtualStartIndex = start
        this.treeVirtualEndIndex = end
        this._visibleTreeItems = this._treeItems.slice(start, end)
    }

    onTreeListScroll (): void {
        if (this.treeViewportRaf) {
            return
        }
        this.treeViewportRaf = window.requestAnimationFrame(() => {
            this.treeViewportRaf = undefined
            this.updateVisibleTreeItems()
            this.cdr.markForCheck()
        })
    }

    trackTreeItem (index: number, item: { node: TreeNode, depth: number }): string {
        const key = item.node.path || item.node.docId || item.node.name
        return `${key}:${item.depth}`
    }

    private getVisibleDiffCandidates (): EditorDocument[] {
        const result: EditorDocument[] = []
        const seen = new Set<string>()
        for (const item of this._treeItems) {
            if (item.node.isFolder) {
                continue
            }
            const docId = item.node.docId
            if (!docId || docId === this.activeDocId || seen.has(docId)) {
                continue
            }
            const doc = this.documents.find(d => d.id === docId)
            if (!doc) {
                continue
            }
            seen.add(docId)
            result.push(doc)
        }
        return result
    }

    private getFallbackDiffCandidates (): EditorDocument[] {
        const result: EditorDocument[] = []
        const seen = new Set<string>()
        for (const doc of this.documents) {
            if (doc.id === this.activeDocId) {
                continue
            }
            const fsKey = this.getFsPathKey(doc.path ?? doc.tempPath ?? null)
            const dedupeKey = fsKey ? `path:${fsKey}` : `doc:${doc.id}`
            if (seen.has(dedupeKey)) {
                continue
            }
            seen.add(dedupeKey)
            result.push(doc)
        }
        return result
    }

    private _diffCandidatesCache: EditorDocument[] | null = null
    private _diffCandidatesCacheDocCount = -1
    private _diffCandidatesCacheActiveId: string | null = null

    get diffCandidates (): EditorDocument[] {
        if (this._diffCandidatesCache && this._diffCandidatesCacheDocCount === this.documents.length && this._diffCandidatesCacheActiveId === this.activeDocId) {
            return this._diffCandidatesCache
        }
        const visible = this.getVisibleDiffCandidates()
        const result = visible.length ? visible : this.getFallbackDiffCandidates()
        this._diffCandidatesCache = result
        this._diffCandidatesCacheDocCount = this.documents.length
        this._diffCandidatesCacheActiveId = this.activeDocId
        return result
    }

    get editorThemePresetValue (): string {
        return this.editorThemePresets.some(x => x.color === this.editorThemeColor) ? this.editorThemeColor : 'custom'
    }

    private getDiffDocContextLabel (doc: EditorDocument): string {
        const refPath = doc.path ?? doc.tempPath ?? null
        if (!refPath) {
            return doc.isDirty ? 'unsaved' : 'buffer'
        }
        const folder = this.getFolderForPath(refPath)
        if (folder) {
            const rel = path.relative(folder, refPath).replace(/\\/g, '/')
            const parent = path.dirname(rel)
            if (parent && parent !== '.') {
                return parent
            }
        }
        const parentName = path.basename(path.dirname(refPath))
        return parentName || 'disk'
    }

    getDiffOptionLabel (doc: EditorDocument): string {
        const candidates = this.diffCandidates
        const sameNameDocs = candidates.filter(d => d.name === doc.name)
        if (sameNameDocs.length <= 1) {
            if (!doc.path) {
                return `${doc.name} (${doc.isDirty ? 'unsaved' : 'buffer'})`
            }
            return doc.name
        }
        const context = this.getDiffDocContextLabel(doc)
        const sameContextDocs = sameNameDocs.filter(d => this.getDiffDocContextLabel(d) === context)
        if (sameContextDocs.length <= 1) {
            return `${doc.name} (${context})`
        }
        const index = sameContextDocs.findIndex(d => d.id === doc.id)
        const suffix = index >= 0 ? ` #${index + 1}` : ''
        return `${doc.name} (${context}${suffix})`
    }

    private updateTreeItems (): void {
        const buildNonce = ++this.treeBuildNonce
        if (this.treeRefreshTimer) {
            clearTimeout(this.treeRefreshTimer)
        }
        const delay = this._treeItems.length > 1200 ? 60 : 20
        this.treeRefreshTimer = window.setTimeout(() => {
            this.treeRefreshTimer = undefined
            void this.rebuildTreeItems(buildNonce)
        }, delay)
    }

    private async rebuildTreeItems (buildNonce: number): Promise<void> {
        const { roots, truncated } = await this.buildTree(buildNonce)
        if (buildNonce !== this.treeBuildNonce) {
            return
        }
        const flat: Array<{ node: TreeNode, depth: number }> = []
        const visit = (node: TreeNode, depth: number) => {
            flat.push({ node, depth })
            if (node.isFolder) {
                const key = node.path || ''
                if (this.expandedFolders.has(key)) {
                    for (const child of node.children) {
                        visit(child, depth + 1)
                    }
                }
            }
        }
        for (const root of roots) {
            // Studio UX: hide the protected workspace root row itself
            // ("Tlink Studio") and render its children at top level.
            if (this.simpleDiskMode && this.isProtectedWorkspaceFolder(root.path)) {
                for (const child of root.children) {
                    visit(child, 0)
                }
                continue
            }
            visit(root, 0)
        }
        // Belt-and-suspenders: post-filter to guarantee no hidden paths leak
        // through, regardless of the code path that triggered the rebuild.
        const beforeCount = flat.length
        const filtered = flat.filter(item => {
            if (item.node.isFolder) {
                return true
            }
            const key = this.toTreePathKey(item.node.path)
            return !key || !this.hiddenTreePathKeys.has(key)
        })
        if (filtered.length < beforeCount) {
            console.warn(`[rebuildTreeItems] Post-filter removed ${beforeCount - filtered.length} hidden item(s) that slipped through buildTree`)
        }
        this._treeItems = filtered
        this.updateVisibleTreeItems(true)
        this.pruneFileSelectionToVisibleTree()
        if (truncated) {
            this.statusMessage = `Explorer truncated to ${this.treeNodeBudget} entries`
            window.setTimeout(() => {
                if (this.statusMessage === `Explorer truncated to ${this.treeNodeBudget} entries`) {
                    this.statusMessage = ''
                }
            }, 2200)
        }
        this.cdr.markForCheck()
    }

    private resolveTerminalService (): TerminalServiceType|null {
        const nodeRequire = this.getNodeRequire()
        if (!nodeRequire) {
            return null
        }

        try {
            const localModule = nodeRequire('tlink-local')
            const token = localModule?.TerminalService
            if (!token) {
                return null
            }
            // TerminalService is providedIn: 'root' in tlink-local, so injector lookup is enough.
            return this.injector.get(token, null)
        } catch {
            return null
        }
    }

    private getNodeRequire (): any {
        return (globalThis as any)?.nodeRequire
            ?? (globalThis as any)?.require
            ?? (globalThis as any)?.window?.nodeRequire
            ?? (globalThis as any)?.window?.require
            ?? null
    }

    private shellSingleQuote (input: string): string {
        return `'${(input ?? '').replace(/'/g, `'\\''`)}'`
    }

    private appleScriptEscape (input: string): string {
        return (input ?? '')
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
    }

    private spawnDetached (command: string, args: string[]): boolean {
        const nodeRequire = this.getNodeRequire()
        if (!nodeRequire) {
            return false
        }
        try {
            const { spawn } = nodeRequire('child_process')
            const child = spawn(command, args, {
                detached: true,
                stdio: 'ignore',
            })
            child.unref()
            return true
        } catch {
            return false
        }
    }

    private openExternalTerminalAndRun (cwd: string, command: string): boolean {
        const safeCwd = path.resolve(cwd || this.folderRoot)
        if (process.platform === 'darwin') {
            const shellLine = `cd ${this.shellSingleQuote(safeCwd)}; ${command}`
            const escaped = this.appleScriptEscape(shellLine)
            return this.spawnDetached('osascript', [
                '-e',
                'tell application "Terminal" to activate',
                '-e',
                `tell application "Terminal" to do script "${escaped}"`,
            ])
        }
        if (process.platform === 'win32') {
            const winCwd = safeCwd.replace(/"/g, '""')
            const shellLine = `cd /d "${winCwd}" && ${command}`
            return this.spawnDetached('cmd.exe', [
                '/c',
                'start',
                '"Tlink Studio Run"',
                'cmd.exe',
                '/k',
                shellLine,
            ])
        }

        const shellLine = `cd ${this.shellSingleQuote(safeCwd)}; ${command}; exec bash`
        const candidates: Array<{ cmd: string, args: string[] }> = [
            { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-lc', shellLine] },
            { cmd: 'gnome-terminal', args: ['--', 'bash', '-lc', shellLine] },
            { cmd: 'konsole', args: ['-e', 'bash', '-lc', shellLine] },
            { cmd: 'xterm', args: ['-e', 'bash', '-lc', shellLine] },
        ]
        for (const candidate of candidates) {
            if (this.spawnDetached(candidate.cmd, candidate.args)) {
                return true
            }
        }
        return false
    }

    private async resolveRunProfile (): Promise<any|null> {
        const preferredId = this.config?.store?.codeEditor?.runProfile
        try {
            const profilesService = this.injector.get(ProfilesService)
            const profiles = await profilesService.getProfiles({ includeBuiltin: true })
            if (preferredId) {
                // Prefer exact ID match; fallback to name match if someone put a name in the field
                return (
                    profiles.find(p => p.id === preferredId) ??
                    profiles.find(p => (p.name ?? '') === preferredId) ??
                    null
                )
            }

            // No explicit run profile configured: prefer fish when available (POSIXShellsProvider reads /etc/shells)
            const fishProfile = profiles.find(p => {
                if (p?.type !== 'local') {
                    return false
                }
                const cmd = p?.options?.command ?? ''
                const base = path.basename(cmd)
                return base === 'fish' || cmd === 'fish'
            }) ?? null

            return fishProfile
        } catch {
            return null
        }
    }

    async ngAfterViewInit (): Promise<void> {
        await this.initializeEditor()
        // Update tree items after initialization to avoid ExpressionChangedAfterItHasBeenCheckedError
        // Use setTimeout to defer to next tick, after change detection completes
        window.setTimeout(() => {
            this.updateTreeItems()
            this.updateVisibleTreeItems(true)
            this.cdr.markForCheck()
        }, 0)
    }

    ngOnDestroy (): void {
        // Flush any pending debounced folder state first, then persist full state.
        if (this.persistFoldersTimer) {
            clearTimeout(this.persistFoldersTimer)
            this.persistFoldersTimer = undefined
            this.flushPersistFolders()
        }
        this.persistState()
        if (this.editorStatePersistTimer) {
            clearTimeout(this.editorStatePersistTimer)
            this.editorStatePersistTimer = undefined
        }
        this.topologyDragNodeId = null
        this.topologyDragChanged = false
        this.topologyDragTextId = null
        this.topologyTextDragChanged = false
        this.flushEditorStateToDisk()
        this.cancelFileMenuClose()
        this.cancelEditMenuClose()
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer)
        }
        if (this.persistStateTimer) {
            clearTimeout(this.persistStateTimer)
        }
        if (this.treeRefreshTimer) {
            clearTimeout(this.treeRefreshTimer)
        }
        if (this.treeViewportRaf) {
            window.cancelAnimationFrame(this.treeViewportRaf)
            this.treeViewportRaf = undefined
        }
        if (this.topologyRenderRaf != null) {
            window.cancelAnimationFrame(this.topologyRenderRaf)
            this.topologyRenderRaf = undefined
        }
        this.clearTopologyPointerSpaceCache()
        if (this.externalWatchTimer) {
            clearInterval(this.externalWatchTimer)
            this.externalWatchTimer = undefined
        }
        this.disposeEditors()
        this.disposeModels()
        // Clear the undo stack to release memory.
        this.closedDocuments = []
        // Dispose any orphaned global Monaco models not tracked in this.documents.
        try {
            const orphanedModels = this.monaco?.editor?.getModels?.() ?? []
            for (const m of orphanedModels) {
                m.dispose?.()
            }
        } catch {
            // ignore
        }
        if (this.externalOpenHandler) {
            window.removeEventListener('tlink-open-in-editor', this.externalOpenHandler)
        }
        super.ngOnDestroy()
    }

    async openFile (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const uploads = await this.platform.startUpload({ multiple: false })
        if (!uploads.length) {
            return
        }
        const upload = uploads[0]
        try {
            const data = await upload.readAll()
            const content = new TextDecoder().decode(data)
            const target = await this.resolveUploadOpenTarget(upload, content)
            this.openDocumentFromContent(target.name, target.filePath, content)
            if (target.imported) {
                this.statusMessage = `Imported ${target.name}`
                this.updateStatus()
            }
        } catch (err: any) {
            this.setError(`Failed to open file: ${err?.message ?? err}`)
        } finally {
            (upload as any).close?.()
        }
    }

    async openLocalFile (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }

        const localRoot = this.ensureWorkspaceRootAttached()
        if (!fsSync.existsSync(localRoot) || !fsSync.statSync(localRoot).isDirectory()) {
            this.setError(`Local folder does not exist: ${localRoot}`)
            return
        }

        // Remove stale nested roots that were accidentally added under Tlink Studio.
        this.pruneNestedWorkspaceFolders(localRoot)

        // Always re-attach local workspace root so Open local still works after closing it from the tree.
        this.attachFolderToTree(localRoot, true)

        type LocalOpenSelection = { kind: 'folder'|'file', targetPath: string }
        const options: SelectorOption<LocalOpenSelection>[] = []

        const localFolders = await this.collectFoldersFromRoots([localRoot], this.quickOpenBudget)
        options.push(...localFolders.map((folderPath): SelectorOption<LocalOpenSelection> => {
            const resolved = path.resolve(folderPath)
            const relative = path.relative(localRoot, resolved).replace(/\\/g, '/')
            const isRoot = !relative
            return {
                name: isRoot ? 'Tlink Studio folder' : `${relative}/`,
                description: resolved,
                group: 'Local folders',
                result: { kind: 'folder', targetPath: resolved },
                weight: isRoot ? -20 : -10,
            }
        }))

        const localFiles = await this.collectFilesFromRoots([this.folderRoot], this.quickOpenBudget)
        options.push(...localFiles.map((filePath): SelectorOption<LocalOpenSelection> => {
            const resolved = path.resolve(filePath)
            const relative = path.relative(localRoot, resolved)
            const displayName = relative && !relative.startsWith('..')
                ? relative.replace(/\\/g, '/')
                : path.basename(resolved)
            return {
                name: displayName,
                description: resolved,
                group: 'Local files',
                result: { kind: 'file', targetPath: resolved as string },
            }
        }))

        if (options.length <= 1) {
            this.statusMessage = `Opened local folder: ${this.getFolderDisplayName(localRoot)}`
            this.updateStatus()
            return
        }

        const picked = await this.app.showSelector<LocalOpenSelection>('Open local', options).catch(() => null)
        if (!picked?.targetPath) {
            return
        }
        const pickedPath = path.resolve(picked.targetPath)
        if (picked.kind === 'folder') {
            if (this.isTreePathEqualOrDescendant(pickedPath, localRoot)) {
                this.attachFolderToTree(localRoot, false)
                this.revealLocalFolderPath(localRoot, pickedPath)
            } else {
                this.attachFolderToTree(pickedPath, true)
            }
            return
        }

        if (this.isTreePathEqualOrDescendant(pickedPath, localRoot)) {
            this.attachFolderToTree(localRoot, false)
            this.revealLocalFolderPath(localRoot, path.dirname(pickedPath))
        } else {
            // Fallback for unexpected external paths.
            this.attachFolderToTree(path.dirname(pickedPath), false)
        }
        await this.openFileFromDiskPath(pickedPath)
    }

    async onExternalTransfer (root: DirectoryUpload): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const uploads = this.collectDroppedFileUploads(root)
        if (!uploads.length) {
            this.statusMessage = 'No files found in drop'
            this.updateStatus()
            return
        }

        let opened = 0
        let imported = 0
        for (const upload of uploads) {
            try {
                const data = await upload.readAll()
                const content = new TextDecoder().decode(data)
                const target = await this.resolveUploadOpenTarget(upload, content)
                this.openDocumentFromContent(target.name, target.filePath, content)
                opened++
                if (target.imported) {
                    imported++
                }
            } catch (err: any) {
                this.setError(`Failed to open dropped file: ${err?.message ?? err}`)
            } finally {
                ;(upload as any).close?.()
            }
        }

        if (opened) {
            if (imported) {
                if (opened === imported) {
                    this.statusMessage = opened === 1 ? 'Imported 1 dropped file' : `Imported ${opened} dropped files`
                } else {
                    this.statusMessage = `Opened ${opened} dropped files (${imported} imported)`
                }
            } else {
                this.statusMessage = opened === 1 ? 'Opened 1 dropped file' : `Opened ${opened} dropped files`
            }
            this.updateStatus()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        }
    }

    private collectDroppedFileUploads (root: DirectoryUpload): FileUpload[] {
        const uploads: FileUpload[] = []
        const walk = (dir: DirectoryUpload): void => {
            for (const child of dir.getChildrens()) {
                if (this.isDirectoryUploadNode(child)) {
                    walk(child)
                } else {
                    uploads.push(child as FileUpload)
                }
            }
        }
        walk(root)
        return uploads
    }

    private isDirectoryUploadNode (entry: DirectoryUpload|FileUpload): entry is DirectoryUpload {
        return typeof (entry as any)?.getChildrens === 'function'
    }

    private resolveUploadFilePath (upload: FileUpload): string|null {
        const anyUpload = upload as any
        const candidates = [
            anyUpload?.filePath,
            anyUpload?.path,
            anyUpload?.file?.path,
        ]
        for (const candidate of candidates) {
            if (typeof candidate !== 'string') {
                continue
            }
            const trimmed = candidate.trim()
            if (!trimmed) {
                continue
            }
            if (path.isAbsolute(trimmed)) {
                return path.resolve(trimmed)
            }
        }
        return null
    }

    private resolveUploadDisplayName (upload: FileUpload, filePath: string|null): string {
        const uploadName = (upload.getName?.() ?? '').trim()
        if (uploadName) {
            return uploadName
        }
        if (filePath) {
            return path.basename(filePath)
        }
        return 'untitled.txt'
    }

    private async resolveUploadOpenTarget (upload: FileUpload, content: string): Promise<{ name: string, filePath: string|null, imported: boolean }> {
        const sourcePath = this.resolveUploadFilePath(upload)
        const sourceName = this.resolveUploadDisplayName(upload, sourcePath)
        if (sourcePath) {
            this.ensurePathVisibleInTree(sourcePath, false, true)
            return { name: sourceName, filePath: sourcePath, imported: false }
        }
        if (this.simpleDiskMode) {
            const targetPath = await this.createSimpleFileOnDisk(sourceName, content, this.getAutosaveTargetFolder())
            this.ensurePathVisibleInTree(targetPath, false, true)
            return { name: path.basename(targetPath), filePath: targetPath, imported: true }
        }
        return { name: sourceName, filePath: null, imported: false }
    }

    async openRecent (filePath: string): Promise<void> {
        if (!filePath) {
            return
        }
        await this.openFileFromDiskPath(filePath)
    }

    async handleRecentSelection (event: any): Promise<void> {
        const value = event?.target?.value ?? ''
        if (!value) {
            return
        }
        await this.openRecent(value)
        if (event?.target) {
            event.target.value = ''
        }
    }

    async openQuickOpen (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }

        const options: SelectorOption<QuickOpenSelection>[] = []
        const seenFiles = new Set<string>()
        options.push({
            name: 'Open file/folder by path',
            description: 'Type an absolute path, ~/ path, or path relative to current directory',
            group: 'Path',
            freeInputPattern: 'Open "%s"',
            callback: query => {
                void this.openFileByUserPath(query ?? '')
            },
            weight: -30,
        })

        const docs = [...this.documents].sort((a, b) => {
            if (a.id === this.activeDocId) return -1
            if (b.id === this.activeDocId) return 1
            return a.name.localeCompare(b.name)
        })
        for (const doc of docs) {
            if (doc.path) {
                seenFiles.add(path.resolve(doc.path))
            }
            options.push({
                name: doc.isDirty ? `${doc.name} •` : doc.name,
                description: doc.path ?? 'Unsaved buffer',
                group: 'Open documents',
                result: { kind: 'doc', docId: doc.id },
                weight: doc.id === this.activeDocId ? -20 : -10,
            })
        }

        for (const recent of this.recentFiles) {
            const filePath = (recent ?? '').trim()
            if (!filePath) {
                continue
            }
            const resolved = path.resolve(filePath)
            if (seenFiles.has(resolved) || !fsSync.existsSync(resolved)) {
                continue
            }
            seenFiles.add(resolved)
            options.push({
                name: this.quickOpenDisplayName(resolved),
                description: resolved,
                group: 'Recent files',
                result: { kind: 'file', filePath: resolved },
                weight: 0,
            })
        }

        const workspaceFiles = await this.collectWorkspaceFiles()
        for (const filePath of workspaceFiles) {
            const resolved = path.resolve(filePath)
            if (seenFiles.has(resolved)) {
                continue
            }
            seenFiles.add(resolved)
            options.push({
                name: this.quickOpenDisplayName(resolved),
                description: resolved,
                group: 'Workspace files',
                result: { kind: 'file', filePath: resolved },
                weight: 10,
            })
        }

        if (!options.length) {
            this.setError('No files available to open')
            return
        }

        const picked = await this.app.showSelector<QuickOpenSelection>('Quick Open', options).catch(() => null)
        if (!picked) {
            return
        }
        if (picked.kind === 'doc' && picked.docId) {
            this.activateDoc(picked.docId)
            return
        }
        if (picked.kind === 'file' && picked.filePath) {
            await this.openFileFromDiskPath(picked.filePath)
        }
    }

    async openFileByPathPrompt (): Promise<void> {
        const input = await this.promptForName('Open file/folder path', '')
        if (input == null) {
            return
        }
        await this.openFileByUserPath(input)
    }

    private resolveUserPathInput (input: string): string|null {
        let raw = (input ?? '').trim()
        if (!raw) {
            return null
        }
        if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith('\'') && raw.endsWith('\''))) {
            raw = raw.slice(1, -1).trim()
        }
        if (!raw) {
            return null
        }

        let expanded = raw
        if (expanded.startsWith('~')) {
            const home = process.env.HOME || os.homedir()
            expanded = path.join(home, expanded.slice(1).replace(/^[/\\]+/, ''))
        }

        if (!path.isAbsolute(expanded)) {
            const cwd = (typeof process !== 'undefined' && (process as any).cwd)
                ? (process as any).cwd()
                : this.folderRoot
            expanded = path.resolve(cwd, expanded)
        } else {
            expanded = path.resolve(expanded)
        }

        return expanded
    }

    private async openFileByUserPath (input: string): Promise<void> {
        const resolved = this.resolveUserPathInput(input)
        if (!resolved) {
            return
        }
        try {
            const stat = await fs.stat(resolved)
            if (stat.isDirectory()) {
                this.attachFolderToTree(resolved, true)
                this.statusMessage = `Opened folder: ${this.getFolderDisplayName(resolved)}`
                this.updateStatus()
                return
            }
            if (!stat.isFile()) {
                this.setError('Path is not a regular file or directory.')
                return
            }
        } catch (err: any) {
            this.setError(`Cannot open ${resolved}: ${err?.message ?? err}`)
            return
        }
        await this.openFileFromDiskPath(resolved)
    }

    private quickOpenDisplayName (filePath: string): string {
        const resolved = path.resolve(filePath)
        for (const folder of this.folders) {
            const root = path.resolve(folder.path)
            if (resolved === root || resolved.startsWith(root + path.sep)) {
                const rel = path.relative(root, resolved)
                return rel || path.basename(resolved)
            }
        }
        return path.basename(resolved)
    }

    private getExistingRootPaths (roots: Array<string|null|undefined>): string[] {
        const unique = new Set<string>()
        for (const root of roots) {
            if (!root) {
                continue
            }
            let resolved = ''
            try {
                resolved = path.resolve(root)
            } catch {
                continue
            }
            try {
                if (!fsSync.existsSync(resolved) || !fsSync.statSync(resolved).isDirectory()) {
                    continue
                }
            } catch {
                continue
            }
            unique.add(resolved)
        }
        return Array.from(unique)
    }

    private async collectFilesFromRoots (roots: Array<string|null|undefined>, limit = this.quickOpenBudget): Promise<string[]> {
        const files: string[] = []
        const queue = this.getExistingRootPaths(roots)
        const visited = new Set<string>()

        while (queue.length && files.length < limit) {
            const dir = queue.shift()!
            if (visited.has(dir)) {
                continue
            }
            visited.add(dir)
            let entries: any[] = []
            try {
                entries = await fs.readdir(dir, { withFileTypes: true }) as any[]
            } catch {
                continue
            }
            for (const entry of entries) {
                const name = entry?.name
                if (!name || name === '.' || name === '..') {
                    continue
                }
                const fullPath = path.join(dir, name)
                const isSymLink = typeof entry.isSymbolicLink === 'function' ? entry.isSymbolicLink() : false
                if (isSymLink) {
                    continue
                }
                const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false
                if (isDir) {
                    if (!this.skippedFolders.has(name)) {
                        queue.push(fullPath)
                    }
                    continue
                }
                files.push(fullPath)
                if (files.length >= limit) {
                    break
                }
            }
        }

        return files
    }

    private async collectFoldersFromRoots (roots: Array<string|null|undefined>, limit = this.quickOpenBudget): Promise<string[]> {
        const folders: string[] = []
        const queue = this.getExistingRootPaths(roots)
        const visited = new Set<string>()

        while (queue.length && folders.length < limit) {
            const dir = queue.shift()!
            if (visited.has(dir)) {
                continue
            }
            visited.add(dir)
            folders.push(dir)

            let entries: any[] = []
            try {
                entries = await fs.readdir(dir, { withFileTypes: true }) as any[]
            } catch {
                continue
            }
            for (const entry of entries) {
                const name = entry?.name
                if (!name || name === '.' || name === '..') {
                    continue
                }
                const isSymLink = typeof entry.isSymbolicLink === 'function' ? entry.isSymbolicLink() : false
                if (isSymLink) {
                    continue
                }
                const isDir = typeof entry.isDirectory === 'function' ? entry.isDirectory() : false
                if (!isDir || this.skippedFolders.has(name)) {
                    continue
                }
                queue.push(path.join(dir, name))
            }
        }

        return folders
    }

    private async collectWorkspaceFiles (): Promise<string[]> {
        return this.collectFilesFromRoots(this.folders.map(f => f.path), this.quickOpenBudget)
    }

    async saveFile (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const doc = this.getActiveDoc()
        if (!doc) {
            return
        }
        await this.saveDocument(doc)
    }

    async saveAllFiles (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        // Keep the active topology document model in sync before save pass.
        if (this.topologyCanvasMode && this.topologyData) {
            this.persistTopologyToDoc()
        }
        const dirtyDocs = this.documents.filter(doc => doc.isDirty)
        if (!dirtyDocs.length) {
            this.statusMessage = 'All open files are already saved'
            this.updateStatus()
            return
        }

        let savedCount = 0
        let failedCount = 0
        for (const doc of dirtyDocs) {
            if (!this.isModelAlive(doc)) {
                failedCount++
                continue
            }
            const ok = await this.saveDocument(doc)
            if (ok) {
                savedCount++
            } else if (doc.isDirty) {
                failedCount++
            }
        }

        if (!failedCount) {
            this.statusMessage = `Saved ${savedCount} file${savedCount === 1 ? '' : 's'}`
            this.updateStatus()
            return
        }
        this.setError(`Saved ${savedCount} file${savedCount === 1 ? '' : 's'}, ${failedCount} failed`)
    }

    async saveFileAs (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const doc = this.getActiveDoc()
        if (!doc) {
            return
        }
        const content = doc.model.getValue()
        const data = new TextEncoder().encode(content)
        const download = await this.platform.startDownload(doc.name || 'untitled.txt', 0o644, data.length)
        if (!download) {
            return
        }
        try {
            await download.write(data)
            download.close()
            doc.isDirty = false
            doc.lastSavedValue = content
            const newPath = (download as any).filePath ?? null
            if (newPath) {
                doc.path = newPath
                doc.name = path.basename(newPath)
                doc.folderPath = this.getFolderForPath(newPath) ?? doc.folderPath
                this.rememberRecent(newPath)
                this.setModelLanguage(doc)
                this.refreshDocDiskSnapshot(doc, content)
            }
            if (doc.tempPath) {
                await this.deleteTemp(doc.tempPath)
                doc.tempPath = null
            }
            this.updateTitle(doc)
            this.syncOpenedFileScopes()
            this.updateTreeItems()
            this.persistState()
        } catch (err: any) {
            this.setError(`Failed to save file: ${err?.message ?? err}`)
        }
    }

    async reopenClosed (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const snapshot = this.closedDocuments.pop()
        if (!snapshot) {
            return
        }
        const doc = this.createDocument(snapshot)
        doc.isDirty = !!snapshot.isDirty
        doc.lastSavedValue = snapshot.lastSavedValue ?? snapshot.content
        this.refreshDocDiskSnapshot(doc, snapshot.content)
        this.documents.push(doc)
        this.syncOpenedFileScopes()
        this.activateDoc(doc.id)
        if ((snapshot.content ?? '').includes('\u001b[')) {
            this.applyAnsiDecorations(doc, snapshot.content ?? '')
        }
        if (!doc.path) {
            if (!doc.tempPath) {
                const autosaveFolder = doc.folderPath ?? this.selectedFolderPath ?? this.folderRoot
                doc.folderPath = doc.folderPath ?? autosaveFolder
                doc.tempPath = this.allocateTempPath(doc.name || 'untitled', autosaveFolder)
            }
            // The path was hidden when the doc was closed; un-hide it
            // so the restored file appears in the tree and can be saved.
            this.revealTreePath(doc.tempPath)
            // Also remove from the session kill-list so saveTemp works.
            const restoreKey = this.toTreePathKey(doc.tempPath)
            if (restoreKey) { this.deletedTempPaths.delete(restoreKey) }
            this.queueSaveTemp(doc)
        }
        this.updateTreeItems()
        this.persistState()
    }

    async closeDocument (docId: string, deferPersist = false, forceClose = false): Promise<void> {
        const doc = this.documents.find(d => d.id === docId)
        if (!doc) {
            return
        }

        // ── 1. Confirm with user (skip when caller already confirmed) ──
        if (!forceClose && !(await this.confirmDiscard(doc))) {
            return
        }

        // ── 2. Snapshot for undo (skip for permanent deletes) ──
        if (!forceClose) {
            this.closedDocuments.push(this.snapshotDocument(doc))
            if (this.closedDocuments.length > 20) {
                this.closedDocuments = this.closedDocuments.slice(-20)
            }
        }

        // ── 3. Capture temp path, then tear down the doc ──
        const closingTempPath = (!doc.path && doc.tempPath) ? doc.tempPath : null
        const pendingTimer = this.tempSaveTimers.get(doc.id)
        if (pendingTimer) {
            clearTimeout(pendingTimer)
            this.tempSaveTimers.delete(doc.id)
        }
        doc.modelDisposables?.forEach(d => d.dispose?.())
        doc.modelDisposables = []
        doc.model?.dispose?.()

        // ── 4. Remove from list ──
        this.documents = this.documents.filter(d => d.id !== docId)

        // ── 5. Delete temp file from disk + block re-creation ──
        if (closingTempPath) {
            try { fsSync.unlinkSync(closingTempPath) } catch { /* already gone or locked */ }
            this.hideTreePath(closingTempPath)
            // Add to session kill-list so saveTemp can never
            // re-create this file, regardless of timers / races.
            const killKey = this.toTreePathKey(closingTempPath)
            if (killKey) { this.deletedTempPaths.add(killKey) }
        }

        // ── 6. Activate next doc ──
        if (this.activeDocId === docId) {
            const next = this.documents[0]
            this.activeDocId = next?.id ?? null
            this.refreshActiveDocCache()
            this.primaryEditor?.setModel(next?.model ?? null)
        }
        if (this.splitDocId === docId) {
            this.splitDocId = null
            this.refreshActiveDocCache()
            this.splitEditor?.setModel(this.getActiveDoc()?.model ?? null)
        }

        // ── 7. Persist + update UI ──
        // Always flush synchronously — never defer.  The old code
        // used queuePersistState (250ms debounce) when deferPersist
        // was true, which could leave the closed doc in localStorage
        // if the app exited before the timer fired.
        // Cancel any pending debounced persist so it doesn't fire
        // later and accidentally re-serialize stale state.
        if (this.persistStateTimer) {
            clearTimeout(this.persistStateTimer)
            this.persistStateTimer = undefined
        }
        this.persistState()
        if (!forceClose) {
            this.updateTreeItems()
            this.updateStatus()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        }
    }

    openDocContextMenu (event: MouseEvent, docId: string): void {
        event.preventDefault()
        event.stopPropagation()
        this.fileMenuOpen = false
        this.editMenuOpen = false

        this.docContextMenuOpen = true
        this.docContextMenuDocId = docId

        const menuWidth = 220
        const menuHeight = 120
        const padding = 8
        const maxX = Math.max(padding, (window.innerWidth || 0) - menuWidth - padding)
        const maxY = Math.max(padding, (window.innerHeight || 0) - menuHeight - padding)

        this.docContextMenuX = Math.max(padding, Math.min(event.clientX, maxX))
        this.docContextMenuY = Math.max(padding, Math.min(event.clientY, maxY))
    }

    async renameDocument (docId: string): Promise<void> {
        const doc = this.documents.find(d => d.id === docId)
        if (!doc) {
            return
        }

        const suggested = doc.name || (doc.path ? path.basename(doc.path) : 'untitled')
        const input = await this.promptForName('Rename document', suggested)
        const nextName = (input ?? '').trim()
        await this.renameDocumentWithName(docId, nextName)
    }

    private async promptForName (title: string, value: string): Promise<string|null> {
        if (this.ngbModal) {
            try {
                const modal = this.ngbModal.open(PromptModalComponent)
                modal.componentInstance.prompt = title
                modal.componentInstance.value = value
                const res = await modal.result.catch(() => null)
                return res?.value ?? null
            } catch {
                // Fall back to native prompt below.
            }
        }
        if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
            try {
                const result = window.prompt(title, value)
                return result === null ? null : result
            } catch {
                // ignore prompt fallback errors
            }
        }
        return null
    }

    private async confirmAction (message: string, detail?: string, okLabel = 'OK'): Promise<boolean> {
        try {
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message,
                detail,
                buttons: ['Cancel', okLabel],
                defaultId: 1,
                cancelId: 0,
            })
            return result.response === 1
        } catch {
            return false
        }
    }

    private async renameDocumentWithName (docId: string, nextNameRaw: string): Promise<void> {
        const doc = this.documents.find(d => d.id === docId)
        if (!doc) {
            return
        }
        const nextName = (nextNameRaw ?? '').trim()
        if (!nextName || nextName === doc.name) {
            return
        }
        if (/[\/\\]/.test(nextName)) {
            this.setError('Rename must be a file name (no path separators)')
            return
        }

        // Rename on disk when file exists, otherwise just rename the in-memory doc (+ temp file if present)
        if (doc.path) {
            const dir = path.dirname(doc.path)
            const oldPath = doc.path
            const oldKeyBeforeRename = this.getFsPathKey(oldPath)
            const newPath = path.join(dir, nextName)
            if (newPath === oldPath) {
                return
            }
            try {
                if (fsSync.existsSync(newPath)) {
                    this.setError('A file with that name already exists')
                    return
                }
                await fs.rename(oldPath, newPath)
                doc.path = newPath
                doc.name = path.basename(newPath)
                if (this.isModelAlive(doc)) {
                    this.refreshDocDiskSnapshot(doc, doc.model.getValue())
                }
                // update recent list (replace old path + ensure new is at top)
                this.recentFiles = this.recentFiles.map(p => p === oldPath ? newPath : p).filter(Boolean)
                this.rememberRecent(newPath)
                this.setModelLanguage(doc)
                this.updateTitle(doc)
                this.syncOpenedFileScopes()
                this.remapFileSelectionPath(oldPath, newPath, oldKeyBeforeRename)
                this.revealTreePath(newPath)
                this.updateTreeItems()
                window.setTimeout(() => this.cdr.markForCheck(), 0)
                this.persistState()
            } catch (err: any) {
                this.setError(`Failed to rename: ${err?.message ?? err}`)
            }
            return
        }

        const oldTemp = doc.tempPath
        const oldTempKeyBeforeRename = this.getFsPathKey(oldTemp)
        doc.name = nextName
        doc.tempPath = this.allocateTempPath(nextName, doc.folderPath ?? this.selectedFolderPath)
        this.revealTreePath(doc.tempPath)
        // Best-effort: if temp file exists, rename it to match new extension/name
        if (oldTemp && doc.tempPath && fsSync.existsSync(oldTemp)) {
            try {
                await fs.mkdir(path.dirname(doc.tempPath), { recursive: true })
                await fs.rename(oldTemp, doc.tempPath)
            } catch {
                // ignore temp rename failures
            }
        }
        this.setModelLanguage(doc)
        this.updateTitle(doc)
        this.remapFileSelectionPath(oldTemp, doc.tempPath, oldTempKeyBeforeRename)
        this.updateTreeItems()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
        this.persistState()
    }

    startInlineRename (event: MouseEvent, docId: string): void {
        event.stopPropagation()
        const doc = this.documents.find(d => d.id === docId)
        if (!doc) {
            return
        }
        this.editingDocId = docId
        this.editingDocName = doc.name || (doc.path ? path.basename(doc.path) : 'untitled')
        setTimeout(() => {
            const input = document.getElementById(`code-editor-rename-${docId}`) as HTMLInputElement|null
            input?.focus()
            input?.select?.()
        })
    }

    cancelInlineRename (): void {
        this.editingDocId = null
        this.editingDocName = ''
    }

    async commitInlineRename (docId: string): Promise<void> {
        const name = this.editingDocName
        this.cancelInlineRename()
        await this.renameDocumentWithName(docId, name)
    }

    async renameDocumentFromContextMenu (): Promise<void> {
        const docId = this.docContextMenuDocId
        this.docContextMenuOpen = false
        this.docContextMenuDocId = null
        if (docId) {
            await this.renameDocument(docId)
        }
    }

    async closeDocumentFromContextMenu (): Promise<void> {
        const docId = this.docContextMenuDocId
        this.docContextMenuOpen = false
        this.docContextMenuDocId = null
        if (docId) {
            await this.closeDocument(docId)
        }
    }

    async moveDocumentFromContextMenu (folderPath: string|null): Promise<void> {
        const docId = this.docContextMenuDocId
        this.docContextMenuOpen = false
        this.docContextMenuDocId = null
        if (docId) {
            await this.moveDocumentToFolder(docId, folderPath)
        }
    }

    async canClose (): Promise<boolean> {
        if (this.canCloseCheckPromise) {
            return this.canCloseCheckPromise
        }
        this.canCloseCheckPromise = this.canCloseInternal()
        try {
            return await this.canCloseCheckPromise
        } finally {
            this.canCloseCheckPromise = null
        }
    }

    private async canCloseInternal (): Promise<boolean> {
        const dirtyDocs = this.documents.filter(d => d.isDirty)
        if (!dirtyDocs.length) {
            this.confirmedCloseDiscardSignature = null
            return true
        }

        const signature = this.getDirtyDocsSignature(dirtyDocs)
        if (this.confirmedCloseDiscardSignature === signature) {
            return true
        }

        const leadDoc = dirtyDocs[0]
        const message = dirtyDocs.length === 1
            ? `Close ${leadDoc.name} without saving?`
            : `Close ${dirtyDocs.length} unsaved files without saving?`
        const detail = dirtyDocs.length === 1
            ? 'Unsaved changes will be lost.'
            : 'Unsaved changes in open files will be lost.'

        let response = 0
        try {
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message,
                detail,
                buttons: ['Cancel', 'Save all', 'Discard'],
                defaultId: 1,
                cancelId: 0,
            })
            response = result.response
        } catch {
            this.confirmedCloseDiscardSignature = null
            return false
        }

        if (response === 0) {
            this.confirmedCloseDiscardSignature = null
            return false
        }

        if (response === 1) {
            await this.saveAllFiles()
            if (this.documents.some(doc => doc.isDirty)) {
                this.confirmedCloseDiscardSignature = null
                return false
            }
            this.confirmedCloseDiscardSignature = null
            return true
        }

        this.confirmedCloseDiscardSignature = signature
        return true
    }

    private getDirtyDocsSignature (dirtyDocs: EditorDocument[]): string {
        const parts = dirtyDocs.map(doc => {
            const model = doc.model
            const version =
                model?.getAlternativeVersionId?.()
                ?? model?.getVersionId?.()
                ?? model?.getValueLength?.()
                ?? model?.getValue?.()?.length
                ?? 0
            return `${doc.id}:${version}`
        })
        parts.sort()
        return parts.join('|')
    }

    async getRecoveryToken (_options?: GetRecoveryTokenOptions): Promise<RecoveryToken> {
        return { type: 'app:code-editor' }
    }

    get statusLabel (): string {
        if (this.loadError) {
            return this.loadError
        }
        if (this.statusMessage) {
            return this.statusMessage
        }
        if (this.loading) {
            return 'Loading Monaco editor…'
        }
        return ''
    }

    async copySelection (): Promise<void> {
        if (this.topologyCanvasMode) {
            this.copySelectedTopologyNodesToClipboard()
            return
        }
        if (!(await this.ensureEditor())) {
            return
        }
        const editor = this.getActiveEditor()
        if (editor && await this.runEditorActionSafely('editor.action.clipboardCopyAction')) {
            return
        }
        const model = this.getActiveDoc()?.model ?? editor?.getModel?.()
        if (!editor || !model) {
            return
        }
        const textSelections = this.getTextSelections(editor)
        if (!textSelections.length) {
            return
        }
        const separator = model.getEOL?.() ?? '\n'
        const text = textSelections.map(selection => model.getValueInRange(selection)).join(separator)
        if (!text) {
            return
        }
        await this.writeTextToClipboard(text)
    }

    async pasteClipboard (): Promise<void> {
        if (this.topologyCanvasMode) {
            this.pasteTopologyNodesFromClipboard()
            return
        }
        if (!(await this.ensureEditor())) {
            return
        }
        const editor = this.getActiveEditor()
        if (!editor) {
            return
        }
        const text = await this.readTextFromClipboard()
        if (!text) {
            return
        }
        // Use Monaco's 'type' command which properly distributes text
        // across all cursors in column/multi-cursor selection mode,
        // just like real keyboard typing does.
        editor.trigger('clipboard', 'type', { text })
        editor.focus?.()
        const doc = this.getActiveDoc()
        if (doc) {
            doc.isDirty = true
            this.updateTitle(doc)
        }
    }

    private async readTextFromClipboard (): Promise<string> {
        let text = ''
        try {
            text = this.platform.readClipboard() ?? ''
        } catch {
            text = ''
        }
        if (!text && typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
            try {
                text = await navigator.clipboard.readText()
            } catch {
                // ignore and return best-effort value
            }
        }
        return text ?? ''
    }

    private async writeTextToClipboard (text: string): Promise<void> {
        try {
            this.platform.setClipboard({ text })
            return
        } catch {
            // fall through to web clipboard fallback
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text)
            } catch {
                // ignore best-effort clipboard fallback
            }
        }
    }

    toggleWordWrap (): void {
        if (!this.monaco) {
            return
        }
        this.wordWrapEnabled = !this.wordWrapEnabled
        this.primaryEditor?.updateOptions({ wordWrap: this.wordWrapEnabled ? 'on' : 'off' })
        this.splitEditor?.updateOptions({ wordWrap: this.wordWrapEnabled ? 'on' : 'off' })
        this.updateStatus()
        this.persistState()
    }

    toggleMinimap (): void {
        this.minimapEnabled = !this.minimapEnabled
        this.primaryEditor?.updateOptions({ minimap: { enabled: this.minimapEnabled } })
        this.splitEditor?.updateOptions({ minimap: { enabled: this.minimapEnabled } })
        this.persistState()
    }

    toggleTheme (event?: MouseEvent): void {
        event?.preventDefault()
        event?.stopPropagation()

        // Determine the actually focused pane in the split layout (terminal vs editor).
        // This is more reliable than tracking "lastFocusedPane" because terminal focus can come from clicks inside xterm.
        const focusedTab = this.parent instanceof SplitTabComponent ? this.parent.getFocusedTab() : null
        const terminalTab = this.isTerminalLikeTab(focusedTab) ? focusedTab as any : null

        if (terminalTab) {
            this.toggleTerminalThemeForTab(terminalTab)
            // Keep terminal focused (the Theme button lives in the editor pane, so we'd otherwise steal focus)
            terminalTab?.parent?.focus?.(terminalTab)
            terminalTab?.focus?.()
            return
        }

        const order = this.supportedThemeModes
        const idx = order.indexOf(this.themeMode)
        this.setThemeMode(order[(idx + 1) % order.length])
    }

    setThemeMode (mode: string): void {
        const next = (mode ?? '').trim() as EditorThemeMode
        if (!this.supportedThemeModes.includes(next)) {
            return
        }
        if (this.themeMode === next) {
            return
        }
        this.themeMode = next
        this.applyTheme()
        this.persistState()
    }

    onEditorThemePresetChange (color: string): void {
        if (!color || color === 'custom') {
            return
        }
        this.setEditorThemeColor(color)
    }

    setEditorThemeColor (color: string): void {
        const normalized = this.normalizeHexColor(color, this.editorThemeColor)
        if (!normalized || normalized === this.editorThemeColor) {
            return
        }
        this.editorThemeColor = normalized
        this.applyTheme()
        this.persistState()
    }

    private normalizeHexColor (color: string, fallback: string): string {
        const value = (color ?? '').trim()
        if (!value) {
            return fallback
        }
        const noHash = value.startsWith('#') ? value.slice(1) : value
        if (/^[0-9a-fA-F]{3}$/.test(noHash)) {
            const expanded = noHash.split('').map(ch => ch + ch).join('')
            return `#${expanded.toLowerCase()}`
        }
        if (/^[0-9a-fA-F]{6}$/.test(noHash)) {
            return `#${noHash.toLowerCase()}`
        }
        return fallback
    }

    private hexToRgb (color: string): { r: number, g: number, b: number }|null {
        const normalized = this.normalizeHexColor(color, '')
        if (!normalized || normalized.length !== 7) {
            return null
        }
        const value = normalized.slice(1)
        const r = parseInt(value.slice(0, 2), 16)
        const g = parseInt(value.slice(2, 4), 16)
        const b = parseInt(value.slice(4, 6), 16)
        if ([r, g, b].some(x => Number.isNaN(x))) {
            return null
        }
        return { r, g, b }
    }

    private toRgba (color: string, alpha: number): string {
        const rgb = this.hexToRgb(color)
        if (!rgb) {
            return `rgba(79, 156, 255, ${alpha})`
        }
        const safeAlpha = Math.max(0, Math.min(1, alpha))
        return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${safeAlpha})`
    }

    private defineEditorThemes (): void {
        if (!this.monaco?.editor?.defineTheme) {
            return
        }
        const accent = this.normalizeHexColor(this.editorThemeColor, '#4f9cff')
        const selectionAccent = accent
        const highlightAccent = selectionAccent
        const editor = this.monaco.editor
        editor.defineTheme('tlink-vs', {
            base: 'vs',
            inherit: true,
            rules: [],
            colors: {
                'focusBorder': accent,
                'editorCursor.foreground': accent,
                'editorLineNumber.activeForeground': accent,
                'editor.selectionBackground': this.toRgba(selectionAccent, 0.28),
                'editor.inactiveSelectionBackground': this.toRgba(selectionAccent, 0.16),
                'editor.selectionHighlightBackground': this.toRgba(selectionAccent, 0.22),
                'editor.wordHighlightBackground': this.toRgba(highlightAccent, 0.14),
                'editor.wordHighlightStrongBackground': this.toRgba(highlightAccent, 0.24),
                'editor.findMatchBackground': this.toRgba(highlightAccent, 0.38),
                'editor.findMatchHighlightBackground': this.toRgba(highlightAccent, 0.25),
                'editorBracketMatch.border': this.toRgba(highlightAccent, 0.6),
                'editorWidget.border': this.toRgba(highlightAccent, 0.65),
                'editorSuggestWidget.highlightForeground': accent,
                'editorLink.activeForeground': accent,
            },
        })
        editor.defineTheme('tlink-vs-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'focusBorder': accent,
                'editorCursor.foreground': accent,
                'editorLineNumber.activeForeground': accent,
                'editor.selectionBackground': this.toRgba(selectionAccent, 0.35),
                'editor.inactiveSelectionBackground': this.toRgba(selectionAccent, 0.2),
                'editor.selectionHighlightBackground': this.toRgba(selectionAccent, 0.28),
                'editor.wordHighlightBackground': this.toRgba(highlightAccent, 0.2),
                'editor.wordHighlightStrongBackground': this.toRgba(highlightAccent, 0.34),
                'editor.findMatchBackground': this.toRgba(highlightAccent, 0.42),
                'editor.findMatchHighlightBackground': this.toRgba(highlightAccent, 0.3),
                'editorBracketMatch.border': this.toRgba(highlightAccent, 0.68),
                'editorWidget.border': this.toRgba(highlightAccent, 0.72),
                'editorSuggestWidget.highlightForeground': accent,
                'editorLink.activeForeground': accent,
            },
        })
        editor.defineTheme('tlink-hc', {
            base: 'hc-black',
            inherit: true,
            rules: [],
            colors: {
                'focusBorder': accent,
                'editorCursor.foreground': accent,
                'editorLineNumber.activeForeground': accent,
                'editor.selectionBackground': this.toRgba(selectionAccent, 0.45),
                'editor.inactiveSelectionBackground': this.toRgba(selectionAccent, 0.3),
                'editor.selectionHighlightBackground': this.toRgba(selectionAccent, 0.36),
                'editor.wordHighlightBackground': this.toRgba(highlightAccent, 0.32),
                'editor.wordHighlightStrongBackground': this.toRgba(highlightAccent, 0.48),
                'editor.findMatchBackground': this.toRgba(highlightAccent, 0.55),
                'editor.findMatchHighlightBackground': this.toRgba(highlightAccent, 0.42),
                'editorBracketMatch.border': highlightAccent,
                'editorWidget.border': highlightAccent,
                'editorSuggestWidget.highlightForeground': accent,
                'editorLink.activeForeground': accent,
            },
        })
        editor.defineTheme('tlink-solarized-light', {
            base: 'vs',
            inherit: true,
            rules: [],
            colors: {
                'focusBorder': accent,
                'editor.background': '#fdf6e3',
                'editor.foreground': '#657b83',
                'editorLineNumber.foreground': '#93a1a1',
                'editorLineNumber.activeForeground': accent,
                'editorCursor.foreground': accent,
                'editor.selectionBackground': this.toRgba(selectionAccent, 0.26),
                'editor.inactiveSelectionBackground': this.toRgba(selectionAccent, 0.16),
                'editor.selectionHighlightBackground': this.toRgba(selectionAccent, 0.2),
                'editor.wordHighlightBackground': this.toRgba(highlightAccent, 0.12),
                'editor.wordHighlightStrongBackground': this.toRgba(highlightAccent, 0.2),
                'editor.findMatchBackground': this.toRgba(highlightAccent, 0.36),
                'editor.findMatchHighlightBackground': this.toRgba(highlightAccent, 0.22),
                'editorBracketMatch.border': this.toRgba(highlightAccent, 0.6),
                'editorWidget.border': this.toRgba(highlightAccent, 0.62),
                'editorSuggestWidget.highlightForeground': accent,
                'editorLink.activeForeground': accent,
            },
        })
        editor.defineTheme('tlink-solarized-dark', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'focusBorder': accent,
                'editor.background': '#002b36',
                'editor.foreground': '#93a1a1',
                'editorLineNumber.foreground': '#586e75',
                'editorLineNumber.activeForeground': accent,
                'editorCursor.foreground': accent,
                'editor.selectionBackground': this.toRgba(selectionAccent, 0.36),
                'editor.inactiveSelectionBackground': this.toRgba(selectionAccent, 0.2),
                'editor.selectionHighlightBackground': this.toRgba(selectionAccent, 0.28),
                'editor.wordHighlightBackground': this.toRgba(highlightAccent, 0.2),
                'editor.wordHighlightStrongBackground': this.toRgba(highlightAccent, 0.3),
                'editor.findMatchBackground': this.toRgba(highlightAccent, 0.42),
                'editor.findMatchHighlightBackground': this.toRgba(highlightAccent, 0.28),
                'editorBracketMatch.border': this.toRgba(highlightAccent, 0.7),
                'editorWidget.border': this.toRgba(highlightAccent, 0.74),
                'editorSuggestWidget.highlightForeground': accent,
                'editorLink.activeForeground': accent,
            },
        })
        editor.defineTheme('tlink-dracula', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'focusBorder': accent,
                'editor.background': '#282a36',
                'editor.foreground': '#f8f8f2',
                'editorLineNumber.foreground': '#6272a4',
                'editorLineNumber.activeForeground': accent,
                'editorCursor.foreground': accent,
                'editor.selectionBackground': this.toRgba(selectionAccent, 0.34),
                'editor.inactiveSelectionBackground': this.toRgba(selectionAccent, 0.2),
                'editor.selectionHighlightBackground': this.toRgba(selectionAccent, 0.28),
                'editor.wordHighlightBackground': this.toRgba(highlightAccent, 0.2),
                'editor.wordHighlightStrongBackground': this.toRgba(highlightAccent, 0.32),
                'editor.findMatchBackground': this.toRgba(highlightAccent, 0.44),
                'editor.findMatchHighlightBackground': this.toRgba(highlightAccent, 0.3),
                'editorBracketMatch.border': this.toRgba(highlightAccent, 0.74),
                'editorWidget.border': this.toRgba(highlightAccent, 0.78),
                'editorSuggestWidget.highlightForeground': accent,
                'editorLink.activeForeground': accent,
            },
        })
        editor.defineTheme('tlink-monokai', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'focusBorder': accent,
                'editor.background': '#272822',
                'editor.foreground': '#f8f8f2',
                'editorLineNumber.foreground': '#75715e',
                'editorLineNumber.activeForeground': accent,
                'editorCursor.foreground': accent,
                'editor.selectionBackground': this.toRgba(selectionAccent, 0.34),
                'editor.inactiveSelectionBackground': this.toRgba(selectionAccent, 0.2),
                'editor.selectionHighlightBackground': this.toRgba(selectionAccent, 0.26),
                'editor.wordHighlightBackground': this.toRgba(highlightAccent, 0.2),
                'editor.wordHighlightStrongBackground': this.toRgba(highlightAccent, 0.32),
                'editor.findMatchBackground': this.toRgba(highlightAccent, 0.44),
                'editor.findMatchHighlightBackground': this.toRgba(highlightAccent, 0.3),
                'editorBracketMatch.border': this.toRgba(highlightAccent, 0.74),
                'editorWidget.border': this.toRgba(highlightAccent, 0.78),
                'editorSuggestWidget.highlightForeground': accent,
                'editorLink.activeForeground': accent,
            },
        })
        editor.defineTheme('tlink-nord', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
                'focusBorder': accent,
                'editor.background': '#2e3440',
                'editor.foreground': '#d8dee9',
                'editorLineNumber.foreground': '#4c566a',
                'editorLineNumber.activeForeground': accent,
                'editorCursor.foreground': accent,
                'editor.selectionBackground': this.toRgba(selectionAccent, 0.34),
                'editor.inactiveSelectionBackground': this.toRgba(selectionAccent, 0.2),
                'editor.selectionHighlightBackground': this.toRgba(selectionAccent, 0.26),
                'editor.wordHighlightBackground': this.toRgba(highlightAccent, 0.2),
                'editor.wordHighlightStrongBackground': this.toRgba(highlightAccent, 0.32),
                'editor.findMatchBackground': this.toRgba(highlightAccent, 0.44),
                'editor.findMatchHighlightBackground': this.toRgba(highlightAccent, 0.3),
                'editorBracketMatch.border': this.toRgba(highlightAccent, 0.74),
                'editorWidget.border': this.toRgba(highlightAccent, 0.78),
                'editorSuggestWidget.highlightForeground': accent,
                'editorLink.activeForeground': accent,
            },
        })
    }

    private cloneColorScheme (scheme: any): any {
        if (!scheme) {
            return scheme
        }
        return {
            ...scheme,
            colors: Array.isArray(scheme.colors) ? [...scheme.colors] : scheme.colors,
        }
    }

    private isSameColorScheme (a: any, b: any): boolean {
        if (!a && !b) {
            return true
        }
        if (!a || !b) {
            return false
        }
        const aColors = Array.isArray(a.colors) ? a.colors : []
        const bColors = Array.isArray(b.colors) ? b.colors : []
        if (aColors.length !== bColors.length) {
            return false
        }
        for (let i = 0; i < aColors.length; i++) {
            if (aColors[i] !== bColors[i]) {
                return false
            }
        }
        return a.foreground === b.foreground
            && a.background === b.background
            && a.cursor === b.cursor
            && (a.selection ?? null) === (b.selection ?? null)
            && (a.selectionForeground ?? null) === (b.selectionForeground ?? null)
            && (a.cursorAccent ?? null) === (b.cursorAccent ?? null)
    }

    private isTerminalLikeTab (tab: any): boolean {
        return !!(tab && typeof tab.configure === 'function' && tab.profile)
    }

    private toggleTerminalThemeForTab (term: any): void {
        if (!term?.profile) {
            return
        }
        const dark = this.config?.store?.terminal?.colorScheme
        const light = this.config?.store?.terminal?.lightColorScheme
        if (!dark || !light) {
            this.statusMessage = 'Terminal theme: unavailable'
            this.updateStatus()
            return
        }

        const current = term.profile.terminalColorScheme
        let next: any|undefined
        // Make the first click visible: switch to the opposite scheme from the current platform theme.
        const platformTheme = this.platform.getTheme()
        const primary = platformTheme === 'dark' ? light : dark
        const secondary = platformTheme === 'dark' ? dark : light

        if (!current) {
            next = this.cloneColorScheme(primary)
        } else if (this.isSameColorScheme(current, primary)) {
            next = this.cloneColorScheme(secondary)
        } else if (this.isSameColorScheme(current, secondary)) {
            next = undefined // follow app
        } else {
            next = this.cloneColorScheme(primary)
        }

        term.profile.terminalColorScheme = next
        try {
            term.configure()
        } catch {
            // ignore
        }
        this.statusMessage = `Terminal theme: ${next?.name ?? 'Follow app'}`
        this.updateStatus()
    }

    setFontSize (value: number): void {
        if (!value) {
            return
        }
        this.fontSize = Math.max(10, Math.min(28, value))
        this.primaryEditor?.updateOptions({ fontSize: this.fontSize, lineHeight: this.lineHeight })
        this.splitEditor?.updateOptions({ fontSize: this.fontSize, lineHeight: this.lineHeight })
        this.persistState()
    }

    setLineHeight (value: number): void {
        if (!value) {
            return
        }
        this.lineHeight = Math.max(14, Math.min(40, value))
        this.primaryEditor?.updateOptions({ lineHeight: this.lineHeight, fontSize: this.fontSize })
        this.splitEditor?.updateOptions({ lineHeight: this.lineHeight, fontSize: this.fontSize })
        this.persistState()
    }

    toggleAutosave (): void {
        this.autosaveEnabled = !this.autosaveEnabled
        this.startAutosave()
        this.persistState()
    }

    async goToLine (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const currentLine = this.getActiveEditor()?.getPosition?.()?.lineNumber ?? 1
        const input = await this.promptForName('Go to line number', String(currentLine))
        if (input == null) {
            return
        }
        const line = parseInt(input.trim(), 10)
        if (!line || !isFinite(line) || line < 1) {
            this.setError('Enter a valid line number')
            return
        }
        this.getActiveEditor()?.revealLine(line)
        this.getActiveEditor()?.setPosition({ lineNumber: line, column: 1 })
        this.getActiveEditor()?.focus()
    }

    async runUndo (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const editor = this.getActiveEditor()
        if (!editor) {
            return
        }
        await editor.getAction?.('undo')?.run?.()
        editor.trigger?.('keyboard', 'undo', null)
    }

    async runRedo (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const editor = this.getActiveEditor()
        if (!editor) {
            return
        }
        await editor.getAction?.('redo')?.run?.()
        editor.trigger?.('keyboard', 'redo', null)
    }

    async cutSelection (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const editor = this.getActiveEditor()
        if (editor && await this.runEditorActionSafely('editor.action.clipboardCutAction')) {
            return
        }
        const model = this.getActiveDoc()?.model ?? editor?.getModel?.()
        if (!editor || !model) {
            return
        }
        const textSelections = this.getTextSelections(editor)
        if (!textSelections.length) {
            return
        }
        const separator = model.getEOL?.() ?? '\n'
        const text = textSelections.map(selection => model.getValueInRange(selection)).join(separator)
        if (!text) {
            return
        }
        await this.writeTextToClipboard(text)
        editor.executeEdits('cut', textSelections.map(selection => ({
            range: selection,
            text: '',
            forceMoveMarkers: true,
        })))
        editor.focus?.()
    }

    async selectAllText (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const editor = this.getActiveEditor()
        if (!editor) {
            return
        }
        await editor.getAction?.('editor.action.selectAll')?.run?.()
        editor.trigger?.('keyboard', 'editor.action.selectAll', null)
        editor.focus?.()
    }

    async runFind (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        this.getActiveEditor()?.trigger('keyboard', 'actions.find', null)
    }

    async runReplace (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        await this.runEditorActionSafely('editor.action.startFindReplaceAction')
    }

    private getEditorStickyNotePrefix (languageId: string): string {
        const lang = (languageId || '').toLowerCase()
        const slashComment = new Set([
            'javascript', 'typescript', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'swift', 'kotlin',
            'scala', 'php', 'dart', 'objective-c', 'objective-cpp', 'javascriptreact', 'typescriptreact',
            'jsonc',
        ])
        const hashComment = new Set([
            'python', 'shell', 'powershell', 'yaml', 'dockerfile', 'ruby', 'perl', 'r', 'makefile', 'toml',
        ])
        if (slashComment.has(lang)) {
            return '//'
        }
        if (hashComment.has(lang)) {
            return '#'
        }
        if (lang === 'sql' || lang === 'plsql') {
            return '--'
        }
        return '//'
    }

    private buildEditorStickyNoteLine (doc: EditorDocument|null, model: any, lineNumber: number, note: string): string {
        const languageId = (doc?.languageId ?? this.monaco?.editor?.getModelLanguageId?.(model) ?? 'plaintext').toLowerCase()
        const lineContent = model?.getLineContent?.(lineNumber) ?? ''
        const indentation = (lineContent.match(/^\s*/) ?? [''])[0]
        if (languageId === 'html' || languageId === 'xml') {
            return `${indentation}<!-- Sticky Note: ${note} -->\n`
        }
        if (languageId === 'css' || languageId === 'scss' || languageId === 'less') {
            return `${indentation}/* Sticky Note: ${note} */\n`
        }
        if (languageId === 'plaintext') {
            return `${indentation}Sticky Note: ${note}\n`
        }
        const prefix = this.getEditorStickyNotePrefix(languageId)
        return `${indentation}${prefix} Sticky Note: ${note}\n`
    }

    async addEditorStickyNote (editorArg?: any): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const editor = editorArg ?? this.getActiveEditor()
        const doc = this.getActiveDoc()
        const model = doc?.model ?? editor?.getModel?.()
        if (!editor || !model || !this.monaco) {
            return
        }
        const input = await this.promptForName('Sticky note', 'Note')
        if (input == null) {
            return
        }
        const note = input.trim()
        if (!note) {
            return
        }
        const position = editor.getPosition?.() ?? { lineNumber: 1, column: 1 }
        const lineNumber = Math.max(1, Number(position.lineNumber ?? 1))
        const text = this.buildEditorStickyNoteLine(doc, model, lineNumber, note)
        const range = new this.monaco.Range(lineNumber, 1, lineNumber, 1)
        editor.pushUndoStop?.()
        editor.executeEdits('editor-sticky-note', [{
            range,
            text,
            forceMoveMarkers: true,
        }])
        editor.pushUndoStop?.()
        editor.setPosition?.({ lineNumber, column: Math.max(1, text.length) })
        editor.focus?.()
        this.statusMessage = 'Sticky note added'
        this.updateStatus()
    }

    async formatDocument (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        await this.runEditorActionSafely('editor.action.formatDocument')
    }

    async formatAsJSON (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const doc = this.getActiveDoc()
        if (!doc) {
            return
        }
        try {
            const parsed = JSON.parse(doc.model.getValue() || '{}')
            const pretty = JSON.stringify(parsed, null, 2)
            doc.model.setValue(pretty)
        } catch (err: any) {
            this.setError(`Invalid JSON: ${err?.message ?? err}`)
        }
    }

    toggleDiagnostics (event?: MouseEvent): void {
        event?.preventDefault()
        event?.stopPropagation()
        this.showDiagnostics = !this.showDiagnostics
    }

    get diagnosticsItems (): Array<{ label: string, value: string }> {
        const loadedPlugins = this.getLoadedPluginNames()
        const selectedFiles = this.getSelectedFilePathsFromTree().length
        const selectedFolders = this.getSelectedFolderPathsFromTree().length
        return [
            { label: 'State file', value: this.getEditorStateFilePath() },
            { label: 'Workspace root', value: path.resolve(this.folderRoot) },
            { label: 'Selected folder', value: this.selectedFolderPath ?? '(none)' },
            { label: 'Selected files', value: String(selectedFiles) },
            { label: 'Selected folders', value: String(selectedFolders) },
            { label: 'Loaded plugins', value: loadedPlugins.length ? loadedPlugins.join(', ') : '(none)' },
        ]
    }

    private getLoadedPluginNames (): string[] {
        const pluginModules = (window as any).pluginModules
        if (!Array.isArray(pluginModules)) {
            return []
        }
        const names = pluginModules
            .map(plugin => {
                const rawName = plugin?.pluginName ?? plugin?.name ?? ''
                if (typeof rawName !== 'string') {
                    return ''
                }
                return rawName.trim()
            })
            .filter(Boolean)
        return Array.from(new Set(names))
    }

    private selectionHasText (selection: any): boolean {
        if (!selection) {
            return false
        }
        return selection.startLineNumber !== selection.endLineNumber || selection.startColumn !== selection.endColumn
    }

    private getTextSelections (editor: any): any[] {
        const allSelections = editor?.getSelections?.() ?? []
        const fallbackSelection = editor?.getSelection?.()
        const selections = Array.isArray(allSelections) && allSelections.length
            ? allSelections
            : (fallbackSelection ? [fallbackSelection] : [])
        return selections.filter(selection => this.selectionHasText(selection))
    }

    private async transformSelectedText (statusMessage: string, transform: (value: string) => string): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const editor = this.getActiveEditor()
        const model = this.getActiveDoc()?.model
        if (!editor || !model) {
            return
        }
        const allSelections = editor.getSelections?.() ?? []
        const fallbackSelection = editor.getSelection?.()
        const selections = Array.isArray(allSelections) && allSelections.length
            ? allSelections
            : (fallbackSelection ? [fallbackSelection] : [])
        const textSelections = selections.filter(selection => this.selectionHasText(selection))
        if (!textSelections.length) {
            this.setError('Select text to format')
            return
        }

        const edits = textSelections.map(selection => ({
            range: selection,
            text: transform(model.getValueInRange(selection)),
            forceMoveMarkers: true,
        }))
        if (!edits.length) {
            return
        }

        editor.pushUndoStop?.()
        editor.executeEdits('text-formatting', edits)
        editor.pushUndoStop?.()
        editor.focus?.()
        this.statusMessage = statusMessage
        this.updateStatus()
    }

    private toTitleCase (value: string): string {
        return value.replace(/[^\s]+/g, token => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    }

    async trimTrailingWhitespace (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        await this.runEditorActionSafely('editor.action.trimTrailingWhitespace')
        this.statusMessage = 'Trimmed trailing spaces'
        this.updateStatus()
    }

    private async runEditorActionSafely (actionId: string): Promise<boolean> {
        const action = this.getActiveEditor()?.getAction(actionId)
        if (!action?.run) {
            return false
        }
        try {
            await action.run()
            return true
        } catch (error) {
            if (this.isCancellationErrorLike(error)) {
                return false
            }
            throw error
        }
    }

    toggleIndentationStyle (): void {
        const doc = this.getActiveDoc()
        if (!doc) {
            return
        }
        const next = !doc.insertSpaces
        doc.insertSpaces = next
        doc.model.updateOptions({ insertSpaces: next })
        this.statusIndent = `${doc.insertSpaces ? 'Spaces' : 'Tabs'}:${doc.tabSize}`
    }

    toggleEditMenu (event?: MouseEvent): void {
        event?.stopPropagation()
        this.cancelEditMenuClose()
        this.cancelFileMenuClose()
        this.editMenuOpen = !this.editMenuOpen
        if (this.editMenuOpen) {
            this.fileMenuOpen = false
        }
    }

    private cancelEditMenuClose (): void {
        if (this.editMenuHoverCloseTimer) {
            clearTimeout(this.editMenuHoverCloseTimer)
            this.editMenuHoverCloseTimer = undefined
        }
    }

    openEditMenuOnHover (): void {
        this.cancelEditMenuClose()
        this.cancelFileMenuClose()
        this.editMenuOpen = true
        this.fileMenuOpen = false
    }

    keepEditMenuOpenOnHover (): void {
        this.cancelEditMenuClose()
        this.editMenuOpen = true
    }

    closeEditMenuOnLeave (): void {
        this.cancelEditMenuClose()
        this.editMenuHoverCloseTimer = window.setTimeout(() => {
            this.editMenuHoverCloseTimer = undefined
            this.editMenuOpen = false
        }, this.menuHoverCloseDelayMs)
    }

    async handleEditAction (action: string): Promise<void> {
        switch (action) {
        case 'quickOpen':
            await this.openQuickOpen()
            break
        case 'undo':
            await this.runUndo()
            break
        case 'redo':
            await this.runRedo()
            break
        case 'find':
            await this.runFind()
            break
        case 'replace':
            await this.runReplace()
            break
        case 'goto':
            await this.goToLine()
            break
        case 'format':
            await this.formatDocument()
            break
        case 'formatJson':
            await this.formatAsJSON()
            break
        case 'uppercase':
            await this.transformSelectedText('Uppercased selection', value => value.toUpperCase())
            break
        case 'lowercase':
            await this.transformSelectedText('Lowercased selection', value => value.toLowerCase())
            break
        case 'titleCase':
            await this.transformSelectedText('Title-cased selection', value => this.toTitleCase(value))
            break
        case 'trimTrailing':
            await this.trimTrailingWhitespace()
            break
        case 'cut':
            await this.cutSelection()
            break
        case 'copy':
            await this.copySelection()
            break
        case 'paste':
            await this.pasteClipboard()
            break
        case 'selectAll':
            await this.selectAllText()
            break
        case 'send':
            await this.sendSelectionToTerminal()
            break
        case 'run':
            await this.runActiveFile()
            break
        case 'openClipboard':
            await this.openFromClipboard()
            break
        case 'wrap':
            this.toggleWordWrap()
            break
        case 'minimap':
            this.toggleMinimap()
            break
        default:
            break
        }
        this.cancelEditMenuClose()
        this.editMenuOpen = false
    }

    toggleFileMenu (event?: MouseEvent): void {
        event?.stopPropagation()
        this.cancelFileMenuClose()
        this.cancelEditMenuClose()
        this.fileMenuOpen = !this.fileMenuOpen
        if (this.fileMenuOpen) {
            this.editMenuOpen = false
        }
    }

    private cancelFileMenuClose (): void {
        if (this.fileMenuHoverCloseTimer) {
            clearTimeout(this.fileMenuHoverCloseTimer)
            this.fileMenuHoverCloseTimer = undefined
        }
    }

    openFileMenuOnHover (): void {
        this.cancelFileMenuClose()
        this.cancelEditMenuClose()
        this.fileMenuOpen = true
        this.editMenuOpen = false
    }

    keepFileMenuOpenOnHover (): void {
        this.cancelFileMenuClose()
        this.fileMenuOpen = true
    }

    closeFileMenuOnLeave (): void {
        this.cancelFileMenuClose()
        this.fileMenuHoverCloseTimer = window.setTimeout(() => {
            this.fileMenuHoverCloseTimer = undefined
            this.fileMenuOpen = false
        }, this.menuHoverCloseDelayMs)
    }

    async handleFileAction (action: string): Promise<void> {
        // Close the file menu immediately so it doesn't stay open and
        // overlay the sidebar/editor while the async action runs.
        this.fileMenuOpen = false
        switch (action) {
        case 'new':
            await this.newFile()
            break
        case 'newTopology':
            await this.createTopologyInFolder(this.getAutosaveTargetFolder())
            break
        case 'newFolder':
            await this.createFolderInFolder(this.selectedFolderPath ?? this.folderRoot)
            break
        case 'open':
            await this.openFile()
            break
        case 'openLocal':
            await this.openLocalFile()
            break
        case 'openPath':
            await this.openFileByPathPrompt()
            break
        case 'save':
            await this.saveFile()
            break
        case 'saveAll':
            await this.saveAllFiles()
            break
        case 'saveAs':
            await this.saveFileAs()
            break
        case 'duplicate':
            {
                const selected = this.getSelectedActionTargets()
                if (selected.fileTargets.length || selected.folderTargets.length) {
                    await this.duplicateSelectionOnDisk(selected.fileTargets, selected.folderTargets)
                } else {
                    const activePath = this.getActiveDoc()?.path
                    if (!activePath) {
                        this.setError('Select at least one file or folder to duplicate.')
                        break
                    }
                    await this.duplicateSelectionOnDisk([activePath], [])
                }
            }
            break
        case 'move':
            {
                const selected = this.getSelectedActionTargets()
                if (selected.fileTargets.length || selected.folderTargets.length) {
                    await this.moveSelectionToFolderPrompt(selected.fileTargets, selected.folderTargets)
                } else {
                    const activePath = this.getActiveDoc()?.path
                    if (!activePath) {
                        this.setError('Select at least one file or folder to move.')
                        break
                    }
                    await this.moveSelectionToFolderPrompt([activePath], [])
                }
            }
            break
        case 'delete':
            {
                const selected = this.getSelectedActionTargets()
                if (selected.fileTargets.length || selected.folderTargets.length) {
                    await this.deleteSelectionOnDisk(selected.fileTargets, selected.folderTargets)
                } else {
                    await this.deleteActiveFileOnDisk()
                }
            }
            break
        case 'reopen':
            await this.reopenClosed()
            break
        default:
            break
        }
        this.cancelFileMenuClose()
        this.fileMenuOpen = false
    }

    toggleEOL (): void {
        const doc = this.getActiveDoc()
        if (!doc || !this.monaco) {
            return
        }
        const next = doc.model.getEOL() === '\r\n'
            ? this.monaco.editor.EndOfLineSequence.LF
            : this.monaco.editor.EndOfLineSequence.CRLF
        doc.model.setEOL(next)
        doc.eol = doc.model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
        this.updateStatus()
    }

    setTabSize (value: number): void {
        const doc = this.getActiveDoc()
        if (!doc || !value) {
            return
        }
        const size = Math.max(1, Math.min(12, value))
        doc.tabSize = size
        doc.model.updateOptions({ tabSize: size })
        this.statusIndent = `${doc.insertSpaces ? 'Spaces' : 'Tabs'}:${doc.tabSize}`
    }

    async compareWithDisk (): Promise<void> {
        const doc = this.getActiveDoc()
        if (!doc?.path) {
            this.setError('File is not saved yet')
            return
        }
        try {
            const content = await fs.readFile(doc.path, 'utf8')
            this.enterDiff(doc, content, `${doc.name} (disk)`)
        } catch (err: any) {
            this.setError(`Compare failed: ${err?.message ?? err}`)
        }
    }

    async compareWithOtherDoc (docId: string): Promise<void> {
        const doc = this.getActiveDoc()
        const other = this.documents.find(d => d.id === docId)
        if (!doc || !other || docId === doc.id) {
            return
        }
        this.enterDiff(doc, other.model.getValue(), this.getDiffOptionLabel(other))
    }

    selectDiffTarget (docId: string): void {
        this.pendingDiffDocId = docId || null
    }

    diffWithSelected (): void {
        if (this.pendingDiffDocId) {
            this.compareWithOtherDoc(this.pendingDiffDocId)
        }
    }

    exitDiffMode (): void {
        this.viewMode = 'editor'
        this.diffEditor?.dispose?.()
        this.diffEditor = null
        this.diffOriginalModel?.dispose?.()
        this.diffOriginalModel = null
        this.statusMessage = ''
        this.layoutEditors()
    }

    toggleSplitView (targetDoc?: EditorDocument): void {
        if (!this.splitHost) {
            return
        }
        this.viewMode = 'editor'
        this.statusMessage = ''
        if (this.splitEditor) {
            this.splitEditor.dispose()
            this.splitEditor = null
            this.splitDocId = null
            this.focusedEditor = 'primary'
            this.refreshActiveDocCache()
            this.layoutEditors()
            this.persistState()
            return
        }
        if (!this.monaco) {
            return
        }
        this.splitEditor = this.monaco.editor.create(this.splitHost.nativeElement, this.editorOptions())
        this.registerEditorShortcuts(this.splitEditor)
        this.splitEditor.onDidFocusEditorText(() => {
            this.focusedEditor = 'split'
            this.updateStatus()
        })
        const docToShow = targetDoc ?? this.pickSplitDoc()
        this.splitDocId = docToShow?.id ?? null
        this.splitEditor.setModel(docToShow?.model ?? null)
        if (docToShow) {
            this.setModelLanguage(docToShow)
        }
        this.layoutEditors()
        this.persistState()
    }

    selectSplitDoc (docId: string): void {
        if (!docId) {
            this.splitDocId = null
            this.splitEditor?.setModel(this.getActiveDoc()?.model ?? null)
            return
        }
        this.splitDocId = docId
        const doc = this.documents.find(d => d.id === docId)
        if (doc) {
            this.splitEditor?.setModel(doc.model)
        }
        this.persistState()
    }

    activateDoc (docId: string, syncTreeSelection = true): void {
        const doc = this.documents.find(d => d.id === docId)
        if (!doc) {
            return
        }
        const docTreePath = doc.path ?? doc.tempPath ?? null
        if (syncTreeSelection) {
            this.setFileSelection(docTreePath ? [docTreePath] : [])
            this.setFolderSelection([])
        }
        this.viewMode = 'editor'
        this.statusMessage = ''
        if (this.splitEditor && this.focusedEditor === 'split') {
            this.splitDocId = docId
            this.splitEditor.setModel(doc.model)
            this.setModelLanguage(doc)
            this.updateStatus()
            this.syncTopologyForActiveDoc()
            this.persistState()
            return
        }
        this.activeDocId = docId
        this.refreshActiveDocCache()
        if (this.pendingDiffDocId === docId) {
            this.pendingDiffDocId = null
        }
        this.primaryEditor?.setModel(doc.model)
        if (!this.splitDocId) {
            this.splitEditor?.setModel(doc.model)
        }
        this.setModelLanguage(doc)
        this.updateTitle(doc)
        this.updateStatus()
        this.syncTopologyForActiveDoc()
        this.persistState()
    }

    async sendSelectionToTerminal (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const model = this.getActiveDoc()?.model
        const editor = this.getActiveEditor()
        if (!model || !editor) {
            return
        }
        const selection = editor.getSelection()
        if (!selection) {
            return
        }
        const text = model.getValueInRange(selection)
        await this.writeTextToClipboard(text)
        window.dispatchEvent(new CustomEvent('tlink-send-to-terminal', { detail: { text } }))
    }

    async openFromClipboard (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const text = await this.readTextFromClipboard()
        if (!text) {
            return
        }
        if (this.simpleDiskMode) {
            try {
                const targetPath = await this.createSimpleFileOnDisk(this.nextUntitledName(), text, this.getAutosaveTargetFolder())
                this.openDocumentFromContent(path.basename(targetPath), targetPath, text)
                this.persistState()
                this.updateTreeItems()
                window.setTimeout(() => this.cdr.markForCheck(), 0)
            } catch (err: any) {
                this.setError(`Failed to open clipboard text: ${err?.message ?? err}`)
            }
            return
        }
        const name = this.nextUntitledName()
        const tempPath = this.allocateTempPath(name, this.selectedFolderPath)
        this.revealTreePath(tempPath)
        const doc = this.createDocument({
            name,
            path: null,
            tempPath,
            folderPath: this.selectedFolderPath,
            content: text,
            languageId: 'plaintext',
            eol: 'LF',
            tabSize: 4,
            insertSpaces: true,
        })
        this.documents.push(doc)
        this.activateDoc(doc.id)
        if (text.includes('\u001b[')) {
            this.applyAnsiDecorations(doc, text)
        }
        this.persistState()
    }

    private async initializeEditor (): Promise<void> {
        try {
            this.loadFoldersFromState()
        // Don't call updateTreeItems here - it will be called in ngAfterViewInit
        // to avoid ExpressionChangedAfterItHasBeenCheckedError
            const monaco = await this.loadMonaco()
            this.defineEditorThemes()
        if (!this.primaryHost) {
            throw new Error('Editor host unavailable')
        }

        if (!this.expandedFolders.size) {
            for (const f of this.folders) {
                this.expandedFolders.add(f.path)
            }
        }

            this.primaryEditor = monaco.editor.create(this.primaryHost.nativeElement, this.editorOptions())
            this.registerEditorShortcuts(this.primaryEditor)
            this.primaryEditor.onDidFocusEditorText(() => {
                this.focusedEditor = 'primary'
                this.updateStatus()
            })

            this.primaryEditor.onDidChangeCursorPosition(() => {
                this.updateStatus()
            })

            await this.restoreState()
            // Immediately re-persist so any stale/deleted docs that were
            // skipped during restore are purged from the persisted state snapshot. This
            // prevents deleted files from reappearing if the app is
            // force-killed before a normal persistState fires.
            this.persistState()
            if (this.pendingSplitDocId) {
                this.restoreSplitView()
            }
            this.loading = false
            this.applyTheme()
            this.layoutEditors()
            this.startAutosave()
            this.startExternalChangeWatcher()
            this.registerExternalHooks()
        } catch (err: any) {
            this.setFatalError(`Failed to load editor: ${err?.message ?? err}`)
        }
    }

    private registerExternalHooks (): void {
        if (this.simpleDiskMode) {
            // In simple mode, only explicit user actions should create files.
            // Background "open in editor" events can re-create deleted files.
            return
        }
        this.externalOpenHandler = (event: Event) => {
            const detail = (event as CustomEvent).detail ?? {}
            if (!detail?.content) {
                return
            }
            const name = detail.name ?? this.nextUntitledName()
            const targetFolder = this.getAutosaveTargetFolder()
            const tempPath = this.allocateTempPath(name, targetFolder)
            this.revealTreePath(tempPath)
            const doc = this.createDocument({
                name,
                path: null,
                tempPath,
                folderPath: targetFolder,
                content: detail.content,
                languageId: detail.languageId ?? 'plaintext',
                eol: 'LF',
                tabSize: 4,
                insertSpaces: true,
            })
            this.documents.push(doc)
            this.activateDoc(doc.id)
        }
        window.addEventListener('tlink-open-in-editor', this.externalOpenHandler)
    }

    private async ensureEditor (): Promise<boolean> {
        if (!this.primaryEditor) {
            await this.initializeEditor()
        }
        if (this.loadError) {
            this.setError(this.loadError ?? 'Editor not initialized')
            return false
        }
        return true
    }

    private editorOptions (): any {
        return {
            automaticLayout: true,
            minimap: { enabled: this.minimapEnabled },
            theme: this.currentThemeId(),
            wordWrap: this.wordWrapEnabled ? 'on' : 'off',
            lineNumbers: 'on',
            lineNumbersMinChars: 3,
            lineDecorationsWidth: 16,
            glyphMargin: false,
            selectOnLineNumbers: true,
            fontSize: this.fontSize,
            lineHeight: this.lineHeight,
            columnSelection: true,
            multiCursorModifier: 'alt',
            // Enable code completion features
            quickSuggestions: {
                other: true,
                comments: true,
                strings: true,
            },
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: 'on',
            tabCompletion: 'on',
            wordBasedSuggestions: 'matchingDocuments',
            parameterHints: {
                enabled: true,
            },
            hover: {
                enabled: true,
            },
        }
    }

    private createDocument (snapshot: EditorDocumentSnapshot): EditorDocument {
        if (!this.monaco) {
            throw new Error('Monaco not ready')
        }
        const model = this.monaco.editor.createModel(snapshot.content, snapshot.languageId || 'plaintext')
        model.setEOL(snapshot.eol === 'CRLF' ? this.monaco.editor.EndOfLineSequence.CRLF : this.monaco.editor.EndOfLineSequence.LF)
        model.updateOptions({ tabSize: snapshot.tabSize, insertSpaces: snapshot.insertSpaces })
        const folderPath = snapshot.folderPath ?? (snapshot.path ? path.dirname(snapshot.path) : null)
        const doc: EditorDocument = {
            ...snapshot,
            folderPath,
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            model,
            modelDisposables: [],
            isDirty: snapshot.isDirty ?? false,
            lastSavedValue: snapshot.lastSavedValue ?? snapshot.content,
            ansiDecorationIds: [],
            diskMtimeMs: null,
            diskSize: null,
            externalConflict: null,
        }
        // Track listener subscriptions for explicit disposal to prevent leaks.
        // Guard callbacks: if the model fires during disposal, bail out.
        doc.modelDisposables.push(model.onDidChangeContent(() => {
            try {
                doc.isDirty = doc.model.getValue() !== doc.lastSavedValue
            } catch { return }  // Model disposed — bail
            if (doc.languageId === 'plaintext') {
                const detected = this.detectLanguageFromContent(doc.model.getValue())
                if (detected && detected !== 'plaintext') {
                    this.monaco.editor.setModelLanguage(doc.model, detected)
                    doc.languageId = detected
                }
            }
            this.updateTitle(doc)
            this.updateStatus()
            this.queuePersistState()
            this.queueSaveTemp(doc)
            if (this.topologyCanvasMode && this.activeDocId === doc.id && !this.topologyWritingDoc) {
                this.loadTopologyFromDoc(doc)
                this.cdr.markForCheck()
            }
        }))
        doc.modelDisposables.push(model.onDidChangeOptions(() => {
            let opts: any
            try { opts = model.getOptions() } catch { return }  // Model disposed — bail
            doc.tabSize = opts.tabSize
            doc.insertSpaces = opts.insertSpaces
            this.updateStatus()
            this.queuePersistState()
        }))
        // Auto-detect language when no extension (untitled)
        if (!snapshot.languageId || snapshot.languageId === 'plaintext') {
            const detected = this.pickLanguage(snapshot.name, snapshot.content)
            if (detected && detected !== 'plaintext') {
                this.monaco.editor.setModelLanguage(model, detected)
                doc.languageId = detected
            }
        }
        return doc
    }

    private openDocumentFromContent (name: string, filePath: string|null, content: string, syncTreeSelection = true): void {
        if (filePath) {
            this.revealTreePath(filePath)
        }
        const existing = this.documents.find(d => this.isSameFsPath(d.path, filePath))
        if (existing) {
            if (!existing.isDirty && this.isModelAlive(existing) && existing.model.getValue() !== content) {
                existing.lastSavedValue = content
                existing.model.setValue(content)
                existing.isDirty = false
                this.updateTitle(existing)
            }
            if (filePath) {
                this.refreshDocDiskSnapshot(existing, content)
            }
            this.syncOpenedFileScopes()
            this.activateDoc(existing.id, syncTreeSelection)
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
            return
        }
        const tempPath = filePath ? null : this.allocateTempPath(name, this.selectedFolderPath)
        if (tempPath) {
            this.revealTreePath(tempPath)
        }
        const doc = this.createDocument({
            name,
            path: filePath,
            tempPath,
            folderPath: this.getFolderForPath(filePath) ?? (filePath ? null : this.selectedFolderPath),
            content,
            languageId: this.pickLanguage(name, content),
            eol: content.includes('\r\n') ? 'CRLF' : 'LF',
            tabSize: 4,
            insertSpaces: true,
        })
        doc.lastSavedValue = content
        this.refreshDocDiskSnapshot(doc, content)
        this.documents.push(doc)
        this.syncOpenedFileScopes()
        this.activateDoc(doc.id, syncTreeSelection)
        if (content.includes('\u001b[')) {
            this.applyAnsiDecorations(doc, content)
        }
        if (filePath) {
            this.rememberRecent(filePath)
        }
        this.persistState()
        this.updateTreeItems()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
    }

    private pickLanguage (fileName: string, content?: string): string {
        const ext = (fileName.split('.').pop() || '').toLowerCase()
        const lang = this.monaco?.languages.getLanguages().find(l => l.extensions?.includes('.' + ext))
        if (lang?.id) {
            return lang.id
        }
        return this.detectLanguageFromContent(content ?? '') || 'plaintext'
    }

    private detectLanguageFromContent (content: string): string {
        const trimmed = content.trimStart()
        const firstLine = trimmed.split('\n')[0] || ''

        if (firstLine.startsWith('#!')) {
            if (firstLine.includes('python')) return 'python'
            if (firstLine.includes('bash') || firstLine.includes('sh')) return 'shell'
            if (firstLine.includes('node')) return 'javascript'
        }

        // JSON detection
        if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
            try {
                JSON.parse(trimmed)
                return 'json'
            } catch (_) {
                // ignore
            }
        }

        // YAML detection
        if (/^---\s/.test(trimmed) || /^[\w-]+:\s/.test(trimmed)) {
            return 'yaml'
        }

        // Python cues
        if (/^\s*import\s+\w+/m.test(content) || /def\s+\w+\(/.test(content)) {
            return 'python'
        }

        // Shell cues
        if (/^\s*(sudo|echo|cd|ls|export)\b/m.test(content) && content.includes('\n')) {
            return 'shell'
        }

        // JS/TS cues
        if (/^\s*(import|export)\s+/.test(content) || /function\s+\w+\(/.test(content)) {
            return 'javascript'
        }

        // HTML
        if (/<(html|body|div|span|head|script|style)[\s>]/i.test(content)) {
            return 'html'
        }

        // CSS
        if (/\.\w+\s*\{[^}]*\}/.test(content)) {
            return 'css'
        }

        return 'plaintext'
    }

    private async saveDocument (doc: EditorDocument): Promise<boolean> {
        if (!this.isModelAlive(doc)) { return false }
        const content = doc.model.getValue()
        const data = new TextEncoder().encode(content)

        const initialPath = doc.path
        if (initialPath) {
            if (this.isPathHiddenInTree(initialPath)) {
                return false
            }
            const initialKey = this.getFsPathKey(initialPath)
            if (initialKey && this.deletingPathKeys.has(initialKey)) {
                return false
            }
            try {
                await fs.mkdir(path.dirname(initialPath), { recursive: true })
                if (!doc.path || !this.isSameFsPath(doc.path, initialPath)) {
                    return false
                }
                if (this.isPathHiddenInTree(doc.path)) {
                    return false
                }
                const currentKey = this.getFsPathKey(doc.path)
                if (currentKey && this.deletingPathKeys.has(currentKey)) {
                    return false
                }
                await fs.writeFile(doc.path, data)
                doc.isDirty = false
                doc.lastSavedValue = content
                this.refreshDocDiskSnapshot(doc, content)
                this.updateTitle(doc)
                this.rememberRecent(doc.path)
                if (doc.tempPath) {
                    await this.deleteTemp(doc.tempPath)
                    doc.tempPath = null
                }
                this.persistState()
                return true
            } catch (err: any) {
                this.setError(`Failed to save file: ${err?.message ?? err}`)
                return false
            }
        }

        const download = await this.platform.startDownload(doc.name || 'untitled.txt', 0o644, data.length)
        if (!download) {
            return false
        }

        try {
            await download.write(data)
            download.close()
            doc.isDirty = false
            doc.lastSavedValue = content
            const newPath = (download as any).filePath ?? null
            if (newPath) {
                doc.path = newPath
                doc.name = path.basename(newPath)
                doc.folderPath = this.getFolderForPath(newPath) ?? doc.folderPath
                this.rememberRecent(newPath)
                this.setModelLanguage(doc)
                this.refreshDocDiskSnapshot(doc, content)
            }
            if (doc.tempPath) {
                await this.deleteTemp(doc.tempPath)
                doc.tempPath = null
            }
            this.updateTitle(doc)
            this.syncOpenedFileScopes()
            this.persistState()
            return true
        } catch (err: any) {
            this.setError(`Failed to save file: ${err?.message ?? err}`)
            return false
        }
    }

    private snapshotDocument (doc: EditorDocument): EditorDocumentSnapshot {
        // Guard against disposed models — fall back to last known values.
        let content = doc.lastSavedValue ?? ''
        let eol: 'LF'|'CRLF' = 'LF'
        let languageId = doc.languageId ?? 'plaintext'
        try {
            content = doc.model.getValue()
            eol = doc.model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
            languageId = this.monaco?.editor.getModelLanguageId?.(doc.model) ?? languageId
        } catch {
            // Model is disposed — use fallback values above.
        }
        return {
            name: doc.name,
            path: doc.path,
            tempPath: doc.tempPath ?? null,
            folderPath: this.resolveDocFolder(doc),
            content,
            languageId,
            eol,
            tabSize: doc.tabSize,
            insertSpaces: doc.insertSpaces,
            isDirty: doc.isDirty,
            lastSavedValue: doc.lastSavedValue,
        }
    }

    private async confirmDiscard (doc: EditorDocument): Promise<boolean> {
        if (!doc.isDirty) {
            return true
        }
        return this.confirmAction(
            `Close ${doc.name} without saving?`,
            'Unsaved changes will be lost.',
            'Discard',
        )
    }

    private updateStatus (): void {
        const doc = this.getActiveDoc()
        const editor = this.getActiveEditor()
        if (!editor || !this.monaco || !doc) {
            this.statusLineCol = ''
            this.statusLanguage = ''
            this.statusEOL = ''
            this.statusIndent = ''
            this.statusWrap = ''
            this.breadcrumbs = []
            return
        }
        const pos = editor.getPosition?.() ?? editor.getModifiedEditor?.()?.getPosition?.()
        this.statusLineCol = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}` : ''
        try {
            const lang = this.monaco.editor.getModelLanguageId?.(doc.model) ?? ''
            this.statusLanguage = lang || ''
            this.statusEOL = doc.model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
        } catch {
            // Model may be disposed — use last known values
            this.statusLanguage = doc.languageId ?? ''
            this.statusEOL = doc.eol ?? 'LF'
        }
        this.statusIndent = `${doc.insertSpaces ? 'Spaces' : 'Tabs'}:${doc.tabSize}`
        this.statusWrap = this.wordWrapEnabled ? 'Wrap:on' : 'Wrap:off'
        this.breadcrumbs = this.buildBreadcrumbs(doc, pos?.lineNumber ?? 0, pos?.column ?? 0)
    }

    private buildBreadcrumbs (doc: EditorDocument, line: number, column: number): string[] {
        const parts = doc.path ? doc.path.split(path.sep).filter(Boolean) : [doc.name]
        if (line) {
            try {
                const word = doc.model.getWordAtPosition({ lineNumber: line, column })?.word
                if (word) {
                    parts.push(word)
                }
            } catch {
                // Model disposed — skip word breadcrumb
            }
        }
        return parts
    }

    beginSidebarResize (event: MouseEvent): void {
        event.preventDefault()
        this.resizingSidebar = true
        this.resizeStartX = event.clientX
        this.resizeStartWidth = this.sidebarWidth
    }

    private resolveMonacoBase (): string {
        const candidates: string[] = []
        const seen = new Set<string>()
        const hasMonaco = (base: string): boolean => {
            try {
                return (
                    fsSync.existsSync(path.join(base, 'vs', 'loader.js')) &&
                    fsSync.existsSync(path.join(base, 'vs', 'editor', 'editor.main.js'))
                )
            } catch {
                return false
            }
        }
        const addCandidate = (candidate?: string|null): void => {
            if (!candidate) {
                return
            }
            const normalized = candidate.replace(/\\/g, '/')
            if (!normalized || seen.has(normalized)) {
                return
            }
            seen.add(normalized)
            candidates.push(normalized)
        }
        const addFileUrlCandidate = (urlValue?: string|null): void => {
            if (!urlValue || typeof urlValue !== 'string') {
                return
            }
            try {
                const parsed = new URL(urlValue)
                if (parsed.protocol !== 'file:') {
                    return
                }
                let filePath = decodeURIComponent(parsed.pathname)
                if (process.platform === 'win32' && filePath.startsWith('/')) {
                    filePath = filePath.slice(1)
                }
                addCandidate(path.join(path.dirname(filePath), 'assets', 'monaco'))
            } catch {
                // ignore malformed URLs
            }
        }

        if (typeof process !== 'undefined' && (process as any).cwd) {
            const cwd = (process as any).cwd()
            addCandidate(path.join(cwd, 'app', 'dist', 'assets', 'monaco'))
            addCandidate(path.join(cwd, 'web', 'dist', 'assets', 'monaco'))
            addCandidate(path.join(cwd, 'dist', 'assets', 'monaco'))
            addCandidate(path.join(cwd, 'assets', 'monaco'))
            addCandidate(path.join(cwd, 'node_modules', 'monaco-editor', 'min'))
        }

        const resourcesPath = (process as any)?.resourcesPath
        if (resourcesPath) {
            addCandidate(path.join(resourcesPath, 'app.asar', 'dist', 'assets', 'monaco'))
            addCandidate(path.join(resourcesPath, 'app.asar.unpacked', 'dist', 'assets', 'monaco'))
            addCandidate(path.join(resourcesPath, 'app', 'dist', 'assets', 'monaco'))
            addCandidate(path.join(resourcesPath, 'web', 'dist', 'assets', 'monaco'))
            addCandidate(path.join(resourcesPath, 'assets', 'monaco'))
            addCandidate(path.join(resourcesPath, 'app.asar', 'assets', 'monaco'))
            addCandidate(path.join(resourcesPath, 'app.asar.unpacked', 'assets', 'monaco'))
            addCandidate(path.join(resourcesPath, 'node_modules', 'monaco-editor', 'min'))
        }

        addFileUrlCandidate((document.currentScript as any)?.src ?? null)
        addFileUrlCandidate((document as any)?.baseURI ?? null)
        addFileUrlCandidate((window as any)?.location?.href ?? null)

        const found = candidates.find(base => hasMonaco(base))
        if (found) {
            return found
        }

        if (resourcesPath) {
            return path.join(resourcesPath, 'assets', 'monaco').replace(/\\/g, '/')
        }

        return 'assets/monaco'
    }

    private loadMonaco (): Promise<Monaco> {
        if (this.monaco) {
            return Promise.resolve(this.monaco)
        }
        if (this.monacoPromise) {
            return this.monacoPromise
        }

        const bindMonacoToInstance = (globalMonaco: Monaco): Monaco => {
            this.monaco = globalMonaco
            this.configureLanguageDefaults()
            this.patchMonacoQuickPickGuards()
            return globalMonaco
        }

        const alreadyLoadedMonaco = (window as any).monaco as Monaco|undefined
        if (alreadyLoadedMonaco) {
            this.monacoPromise = Promise.resolve(bindMonacoToInstance(alreadyLoadedMonaco))
            return this.monacoPromise
        }

        if (!CodeEditorTabComponent.globalMonacoPromise) {
            CodeEditorTabComponent.globalMonacoPromise = new Promise<Monaco>((resolve, reject) => {
                const finish = () => {
                    const globalMonaco = (window as any).monaco as Monaco
                    if (!globalMonaco) {
                        reject(new Error('Monaco not available'))
                        return
                    }
                    // Suppress Monaco's internal listener-LEAK console warnings.
                    // Monaco registers ~200 internal listeners on shared emitters
                    // (e.g. onDidChangeLanguages); creating even a few editor models
                    // exceeds its hard-coded threshold of 200. This is a known Monaco
                    // issue, not a real leak — our models are properly disposed via
                    // modelDisposables tracking.
                    const leakFilter = (args: any[]) =>
                        typeof args[0] === 'string' && args[0].includes('potential listener LEAK')
                    const _origTrace = console.trace
                    const _origWarn = console.warn
                    console.trace = function (...args: any[]) {
                        if (leakFilter(args)) { return }
                        return _origTrace.apply(console, args)
                    }
                    console.warn = function (...args: any[]) {
                        if (leakFilter(args)) { return }
                        return _origWarn.apply(console, args)
                    }
                    resolve(globalMonaco)
                }

                const configureLoader = (amdRequire: any): boolean => {
                    if (!amdRequire?.config) {
                        return false
                    }
                    ;(window as any).MonacoEnvironment = {
                        baseUrl: `${this.monacoBase}/vs`,
                        getWorkerUrl: () => `${this.monacoBase}/vs/base/worker/workerMain.js`,
                    }
                    amdRequire.config({
                        paths: {
                            vs: `${this.monacoBase}/vs`,
                        },
                        // Force browser-style <script> tag loading instead of
                        // Node's require('vm') which is deprecated in Electron's
                        // renderer process.
                        preferScriptTags: true,
                    })
                    amdRequire(['vs/editor/editor.main'], () => finish(), reject)
                    return true
                }

                const existingRequire = (window as any).require
                const existingMonacoAmd = CodeEditorTabComponent.globalMonacoAmdRequire ?? this.monacoAmdRequire ?? (window as any).monacoAmdRequire
                if (existingMonacoAmd?.config) {
                    try {
                        if (configureLoader(existingMonacoAmd)) {
                            return
                        }
                    } catch (err) {
                        reject(err)
                        return
                    }
                }

                if (existingRequire?.config && existingRequire?.toUrl) {
                    try {
                        this.monacoAmdRequire = existingRequire
                        CodeEditorTabComponent.globalMonacoAmdRequire = existingRequire
                        ;(window as any).monacoAmdRequire = existingRequire
                        if (configureLoader(existingRequire)) {
                            return
                        }
                    } catch (err) {
                        reject(err)
                        return
                    }
                }

                const previousRequire = (window as any).require
                const previousModule = (window as any).module
                ;(window as any).require = undefined
                ;(window as any).module = undefined
                // NOTE: Do NOT clear `process` here. Monaco's AMD loader
                // loads modules asynchronously — process would be restored
                // (via restoreGlobals) before modules finish evaluating, so
                // clearing it doesn't suppress the vm warning anyway. Worse,
                // clearing process breaks Electron/Angular code that runs
                // between clearing and the script.onload callback.

                const restoreGlobals = () => {
                    if (previousRequire) {
                        (window as any).require = previousRequire
                    } else {
                        delete (window as any).require
                    }
                    if (previousModule) {
                        (window as any).module = previousModule
                    } else {
                        delete (window as any).module
                    }
                }

                const script = document.createElement('script')
                script.src = `${this.monacoBase}/vs/loader.js`
                script.async = true
                script.setAttribute('data-tlink-monaco-loader', '1')
                script.onload = () => {
                    try {
                        const amdRequire = (window as any).require
                        this.monacoAmdRequire = amdRequire
                        CodeEditorTabComponent.globalMonacoAmdRequire = amdRequire
                        ;(window as any).monacoAmdRequire = amdRequire
                        if (!configureLoader(amdRequire)) {
                            reject(new Error('AMD loader is not ready'))
                            return
                        }
                    } catch (err) {
                        reject(err)
                    } finally {
                        restoreGlobals()
                    }
                }
                script.onerror = () => {
                    restoreGlobals()
                    reject(new Error('Failed to load Monaco loader script'))
                }
                document.body.appendChild(script)
            }).catch(err => {
                CodeEditorTabComponent.globalMonacoPromise = undefined
                throw err
            })
        }

        this.monacoPromise = CodeEditorTabComponent.globalMonacoPromise
            .then(globalMonaco => bindMonacoToInstance(globalMonaco))
            .catch(err => {
                this.monacoPromise = undefined
                throw err
            })

        return this.monacoPromise
    }

    private patchMonacoQuickPickGuards (): void {
        if (CodeEditorTabComponent.monacoQuickPickGuardInstalled) {
            return
        }
        const amdRequire = CodeEditorTabComponent.globalMonacoAmdRequire
            ?? this.monacoAmdRequire
            ?? (window as any).monacoAmdRequire
            ?? (window as any).require
        if (!amdRequire) {
            return
        }
        const normalizeItems = (items: any): any[] => {
            if (Array.isArray(items)) {
                return items
            }
            if (Array.isArray(items?.items)) {
                return items.items
            }
            return []
        }
        const patchQuickPickItems = (module: any): boolean => {
            const proto = module?.QuickPick?.prototype
            if (!proto) {
                return false
            }
            if ((proto as any).__tlinkItemsGuardPatched) {
                return true
            }
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'items')
            if (!descriptor?.set || !descriptor.get) {
                return false
            }
            Object.defineProperty(proto, 'items', {
                configurable: true,
                enumerable: descriptor.enumerable ?? false,
                get: descriptor.get,
                set: function (items: any) {
                    descriptor.set!.call(this, normalizeItems(items))
                },
            })
            Object.defineProperty(proto, '__tlinkItemsGuardPatched', {
                value: true,
                configurable: false,
                enumerable: false,
                writable: false,
            })
            return true
        }
        const patchQuickInputList = (module: any): boolean => {
            const proto = module?.QuickInputList?.prototype
            if (!proto) {
                return false
            }
            if ((proto as any).__tlinkSetElementsGuardPatched) {
                return true
            }
            const originalSetElements = proto.setElements
            if (typeof originalSetElements !== 'function') {
                return false
            }
            proto.setElements = function (inputElements: any) {
                return originalSetElements.call(this, normalizeItems(inputElements))
            }
            Object.defineProperty(proto, '__tlinkSetElementsGuardPatched', {
                value: true,
                configurable: false,
                enumerable: false,
                writable: false,
            })
            return true
        }

        try {
            amdRequire(
                [
                    'vs/platform/quickinput/browser/quickInput',
                    'vs/platform/quickinput/browser/quickInputList',
                ],
                (quickInputModule: any, quickInputListModule: any) => {
                    const quickPickPatched = patchQuickPickItems(quickInputModule)
                    const quickInputListPatched = patchQuickInputList(quickInputListModule)
                    const patched = quickPickPatched || quickInputListPatched
                    if (patched) {
                        CodeEditorTabComponent.monacoQuickPickGuardInstalled = true
                    }
                },
                () => {
                    // Keep default Monaco behavior if quick-input internals are unavailable.
                },
            )
        } catch {
            // Keep default Monaco behavior if quick-input internals are unavailable.
        }
    }

    @HostListener('document:keydown', ['$event'])
    onKeydown (event: KeyboardEvent): void {
        if (event.defaultPrevented) {
            return
        }
        const target = event.target as HTMLElement|null
        if (this.isTextInputLikeTarget(target)) {
            return
        }
        const ctrlOrMeta = event.ctrlKey || event.metaKey
        const key = (event.key ?? '').toLowerCase()
        const isKeyS = key === 's' || event.code === 'KeyS'
        if (ctrlOrMeta && event.altKey && !event.shiftKey && isKeyS) {
            event.preventDefault()
            if (this.topologyCanvasMode) {
                this.persistTopologyToDoc()
            }
            void this.saveAllFiles()
            return
        }
        if (this.topologyCanvasMode) {
            if (ctrlOrMeta && !event.shiftKey && isKeyS) {
                event.preventDefault()
                this.persistTopologyToDoc()
                void this.saveFile()
                return
            }
            if (ctrlOrMeta && event.shiftKey && isKeyS) {
                event.preventDefault()
                this.persistTopologyToDoc()
                void this.saveFileAs()
                return
            }
            if (key === 'escape') {
                const hasInteractiveState =
                    !!this.topologyPendingLinkSourceId ||
                    this.topologyTextPlacementMode ||
                    this.topologyStickyNotePlacementMode ||
                    this.topologyFreeLinkPlacementDirected != null ||
                    !!this.topologyPendingFreeLinkStart ||
                    !!this.topologyFreeLinkDraftEnd ||
                    this.topologyFreeLinkCreating ||
                    !!this.topologyDragFreeLinkId ||
                    !!this.topologyResizeNodeId ||
                    !!this.topologyResizeTextId ||
                    !!this.topologyResizeShapeId ||
                    !!this.topologyDragNodeId ||
                    !!this.topologyDragShapeId ||
                    !!this.topologyDragTextId ||
                    this.topologyMarqueeActive ||
                    this.topologyPanDragActive

                if (hasInteractiveState || this.hasTopologySelection) {
                    this.topologyPendingLinkSourceId = null
                    this.topologyPendingLinkSourceKind = null
                    this.topologyTextPlacementMode = false
                    this.topologyStickyNotePlacementMode = false
                    this.topologyFreeLinkPlacementDirected = null
                    this.resetTopologyFreeLinkDraftState()
                    this.topologyDragNodeId = null
                    this.topologyDragChanged = false
                    this.topologyDragShapeId = null
                    this.topologyShapeDragChanged = false
                    this.topologyDragTextId = null
                    this.topologyTextDragChanged = false
                    this.resetTopologyResizeState()
                    this.cancelTopologyFreeLinkHandleDrag()
                    if (this.topologyMarqueeActive) {
                        this.finishTopologyMarquee()
                    }
                    if (this.topologyPanDragActive) {
                        this.finishTopologyPanDrag()
                    }
                    if (this.hasTopologySelection) {
                        this.clearTopologySelection()
                    }
                    event.preventDefault()
                    this.cdr.markForCheck()
                    return
                }
            }
            if (ctrlOrMeta && !event.shiftKey && key === 'z') {
                event.preventDefault()
                this.runTopologyUndo()
                return
            }
            if (ctrlOrMeta && ((event.shiftKey && key === 'z') || key === 'y')) {
                event.preventDefault()
                this.runTopologyRedo()
                return
            }
            if (ctrlOrMeta && !event.shiftKey && key === 'c') {
                if (this.copySelectedTopologyNodesToClipboard()) {
                    event.preventDefault()
                }
                return
            }
            if (ctrlOrMeta && !event.shiftKey && key === 'v') {
                if (this.pasteTopologyNodesFromClipboard()) {
                    event.preventDefault()
                }
                return
            }
            if (ctrlOrMeta && !event.shiftKey && key === 'd') {
                event.preventDefault()
                this.duplicateSelectedTopologyNodes()
                return
            }
        }
        if (this.topologyCanvasMode && (event.key === 'Delete' || event.key === 'Backspace')) {
            if (!this.canDeleteSelectedTopology) {
                return
            }
            event.preventDefault()
            this.removeSelectedTopologyItem()
            return
        }
        if (this.getActiveEditor()?.hasTextFocus?.()) {
            return
        }
        if (!this.treeKeyboardActive) {
            return
        }
        const selection = this.getSelectedActionTargets()
        if (!selection.fileTargets.length && !selection.folderTargets.length) {
            return
        }

        if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault()
            if (!this.deleteInProgress) {
                void this.deleteSelectionOnDisk(selection.fileTargets, selection.folderTargets)
            }
            return
        }

        if (ctrlOrMeta && event.shiftKey && key === 'd') {
            event.preventDefault()
            void this.duplicateSelectionOnDisk(selection.fileTargets, selection.folderTargets)
            return
        }

        if (ctrlOrMeta && event.shiftKey && key === 'm') {
            event.preventDefault()
            void this.moveSelectionToFolderPrompt(selection.fileTargets, selection.folderTargets)
        }
    }

    private isTextInputLikeTarget (target: HTMLElement|null): boolean {
        if (!target) {
            return false
        }
        const tag = (target.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            return true
        }
        if (target.getAttribute?.('contenteditable') === 'true') {
            return true
        }
        return !!target.closest?.('input, textarea, select, [contenteditable="true"], .rename-input')
    }

    private configureLanguageDefaults (): void {
        if (!this.monaco) {
            return
        }
        this.monaco.languages.typescript?.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
        })
        this.monaco.languages.typescript?.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: false,
            noSyntaxValidation: false,
        })
    }

    private isCancellationErrorLike (error: unknown, depth = 0): boolean {
        if (!error || depth > 4) {
            return false
        }
        const hasCancellationKeyword = (value: string): boolean => {
            const text = value.trim().toLowerCase()
            return text.includes('canceled') || text.includes('cancelled') || text.includes('cancellation')
        }
        if (typeof error === 'string') {
            return hasCancellationKeyword(error)
        }
        if (typeof error !== 'object') {
            return false
        }
        const err = error as any
        const name = typeof err.name === 'string' ? err.name : ''
        const message = typeof err.message === 'string' ? err.message : ''
        if (
            hasCancellationKeyword(name)
            || hasCancellationKeyword(message)
        ) {
            return true
        }
        const nested = err.ngOriginalError ?? err.originalError ?? err.rejection ?? err.reason ?? err.error
        if (!nested || nested === err) {
            return false
        }
        return this.isCancellationErrorLike(nested, depth + 1)
    }

    private applyTheme (): void {
        this.syncShellThemeWithEditorTheme()
        if (!this.monaco) {
            return
        }
        try {
            this.defineEditorThemes()
            this.monaco.editor.setTheme(this.currentThemeId())
        } catch (error) {
            if (!this.isCancellationErrorLike(error)) {
                console.error('Failed to apply editor theme:', error)
            }
        }
    }

    private syncShellThemeWithEditorTheme (): void {
        if (!this.syncAppThemeWithEditor || !this.config?.store?.appearance) {
            return
        }
        const next = this.getShellColorSchemeModeForEditorTheme(this.themeMode)
        if (!next || this.config.store.appearance.colorSchemeMode === next) {
            return
        }
        this.config.store.appearance.colorSchemeMode = next
        this.config.save()
    }

    private getShellColorSchemeModeForEditorTheme (mode: EditorThemeMode): 'auto'|'dark'|'light' {
        if (mode === 'auto') {
            return 'auto'
        }
        if (mode === 'light' || mode === 'solarized-light') {
            return 'light'
        }
        return 'dark'
    }

    private async ensureDocumentOnDisk (doc: EditorDocument): Promise<string|null> {
        if (doc.path) {
            const ok = await this.saveDocument(doc)
            return ok ? doc.path : null
        }
        const target = doc.tempPath ?? this.allocateTempPath(doc.name || 'untitled', doc.folderPath ?? this.selectedFolderPath)
        if (!doc.tempPath) {
            this.revealTreePath(target)
        }
        doc.tempPath = target
        try {
            await fs.mkdir(path.dirname(target), { recursive: true })
            await fs.writeFile(target, doc.model.getValue(), 'utf8')
            return target
        } catch {
            return null
        }
    }

    private getActiveSelectionText (): string|null {
        const editor = this.getActiveEditor()
        const model = this.getActiveDoc()?.model
        if (!editor || !model) {
            return null
        }
        const selection = editor.getSelection?.()
        if (!selection) {
            return null
        }
        // Monaco selection is empty when start==end
        if (
            selection.startLineNumber === selection.endLineNumber &&
            selection.startColumn === selection.endColumn
        ) {
            return null
        }
        const text = model.getValueInRange(selection)
        return text?.trim?.() ? text : null
    }

    private allocateTempPathForSnippet (baseName: string): string {
        // Keep extension so buildRunCommand can pick the right runner (python/node/bash/etc.)
        const compactName = this.toCompactAutoFileName(baseName || 'snippet.txt')
        const ext = path.extname(compactName) || '.txt'
        const stem = path.basename(compactName, ext) || 'snippet'
        const tempDir = this.getTempDir()
        let candidate = path.join(tempDir, `${stem}${ext}`)
        let index = 1
        while (fsSync.existsSync(candidate) && index < 1000) {
            candidate = path.join(tempDir, `${stem}-${index}${ext}`)
            index++
        }
        if (fsSync.existsSync(candidate)) {
            candidate = path.join(tempDir, `${stem}-${Date.now().toString(36)}${ext}`)
        }
        return candidate
    }

    private async ensureSnippetOnDisk (doc: EditorDocument, snippet: string): Promise<string|null> {
        const filePath = this.allocateTempPathForSnippet(doc.name || 'snippet.txt')
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true })
            await fs.writeFile(filePath, snippet, 'utf8')
            return filePath
        } catch {
            return null
        }
    }

    private buildRunCommand (doc: EditorDocument, filePath: string): string {
        const ext = (path.extname(doc.name || '') || '').toLowerCase()
        switch (ext) {
        case '.py':
            return `python3 "${filePath}"`
        case '.js':
        case '.mjs':
        case '.cjs':
            return `node "${filePath}"`
        case '.ts':
            return `ts-node "${filePath}"`
        case '.sh':
            return `bash "${filePath}"`
        default:
            return `bash "${filePath}"`
        }
    }

    async runActiveFile (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        const doc = this.getActiveDoc()
        if (!doc) {
            return
        }
        const selection = this.getActiveSelectionText()
        const filePath = selection
            ? await this.ensureSnippetOnDisk(doc, selection)
            : await this.ensureDocumentOnDisk(doc)
        if (!filePath) {
            this.setError('Save the file before running.')
            return
        }
        const cmd = this.buildRunCommand(doc, filePath)
        const terminal = await this.ensureRunTerminal(path.dirname(filePath))
        if (terminal) {
            this.sendToTerminal(terminal, `${cmd}\n`)
            this.statusMessage = `Running in terminal: ${cmd}`
            this.updateStatus()
            return
        }
        const launched = this.openExternalTerminalAndRun(path.dirname(filePath), cmd)
        if (!launched) {
            this.setError('Unable to open run terminal')
            return
        }
        this.statusMessage = `Running in external terminal: ${cmd}`
        this.updateStatus()
    }

    async closeRunTerminal (): Promise<void> {
        const tab = this.runTerminalTab as (BaseTabComponent|null)
        if (!tab) {
            return
        }
        // Clear reference early to avoid re-entrancy
        this.runTerminalTab = null
        try {
            tab.destroy()
        } catch (err) {
            console.warn('Failed to close run terminal tab', err)
        }
    }

    private pickSplitDoc (): EditorDocument|null {
        if (this.pendingSplitDocId) {
            const match = this.documents.find(d => d.id === this.pendingSplitDocId)
            this.pendingSplitDocId = null
            if (match) {
                return match
            }
        }
        const activeDoc = this.getActiveDoc()
        const otherDoc = this.documents.find(d => d.id !== activeDoc?.id)
        if (otherDoc) {
            return otherDoc
        }
        if (activeDoc && this.isModelAlive(activeDoc)) {
            const name = `${activeDoc.name} copy`
            const copyTempPath = this.allocateTempPath(name, this.selectedFolderPath)
            this.revealTreePath(copyTempPath)
            const doc = this.createDocument({
                name,
                path: null,
                tempPath: copyTempPath,
                folderPath: this.selectedFolderPath,
                content: activeDoc.model.getValue(),
                languageId: activeDoc.languageId,
                eol: activeDoc.eol,
                tabSize: activeDoc.tabSize,
                insertSpaces: activeDoc.insertSpaces,
            })
            doc.isDirty = true
            this.documents.push(doc)
            return doc
        }
        const name = this.nextUntitledName()
        const splitTempPath = this.allocateTempPath(name, this.selectedFolderPath)
        this.revealTreePath(splitTempPath)
        const doc = this.createDocument({
            name,
            path: null,
            tempPath: splitTempPath,
            folderPath: this.selectedFolderPath,
            content: '',
            languageId: 'plaintext',
            eol: 'LF',
            tabSize: 4,
            insertSpaces: true,
        })
        this.documents.push(doc)
        return doc
    }

    private currentThemeId (): string {
        if (this.themeMode === 'light') {
            return 'tlink-vs'
        }
        if (this.themeMode === 'dark') {
            return 'tlink-vs-dark'
        }
        if (this.themeMode === 'hc') {
            return 'tlink-hc'
        }
        if (this.themeMode === 'solarized-light') {
            return 'tlink-solarized-light'
        }
        if (this.themeMode === 'solarized-dark') {
            return 'tlink-solarized-dark'
        }
        if (this.themeMode === 'dracula') {
            return 'tlink-dracula'
        }
        if (this.themeMode === 'monokai') {
            return 'tlink-monokai'
        }
        if (this.themeMode === 'nord') {
            return 'tlink-nord'
        }
        return this.platform.getTheme() === 'dark' ? 'tlink-vs-dark' : 'tlink-vs'
    }

    private restoreSplitView (): void {
        if (!this.pendingSplitDocId) {
            return
        }
        if (!this.splitHost || !this.monaco) {
            this.pendingSplitDocId = null
            return
        }
        if (this.splitEditor) {
            return
        }
        this.viewMode = 'editor'
        this.statusMessage = ''
        this.splitEditor = this.monaco.editor.create(this.splitHost.nativeElement, this.editorOptions())
        this.registerEditorShortcuts(this.splitEditor)
        this.splitEditor.onDidFocusEditorText(() => {
            this.focusedEditor = 'split'
            this.updateStatus()
        })
        const targetDoc = this.pickSplitDoc()
        this.splitDocId = targetDoc?.id ?? null
        this.splitEditor.setModel(targetDoc?.model ?? null)
        if (targetDoc) {
            this.setModelLanguage(targetDoc)
        }
        this.layoutEditors()
        this.persistState()
    }

    private setModelLanguage (doc: EditorDocument): void {
        if (!this.monaco || !doc?.model || !this.isModelAlive(doc)) {
            return
        }
        const lang = this.pickLanguage(doc.name, doc.model.getValue())
        this.monaco.editor.setModelLanguage(doc.model, lang)
        doc.languageId = lang
    }

    private registerEditorShortcuts (editor: any): void {
        if (!this.monaco || !editor) {
            return
        }
        const { KeyMod, KeyCode } = this.monaco
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyZ, () => this.runUndo())
        editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ, () => this.runRedo())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyY, () => this.runRedo())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyX, () => this.cutSelection())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyC, () => this.copySelection())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyV, () => this.pasteClipboard())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyA, () => this.selectAllText())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => this.saveFile())
        editor.addCommand(KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyS, () => this.saveAllFiles())
        editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyS, () => this.saveFileAs())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyP, () => this.openQuickOpen())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyO, () => this.openFile())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyN, () => this.newFile())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyF, () => this.runFind())
        editor.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF, () => this.runReplace())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyG, () => this.goToLine())
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.Enter, () => this.runActiveFile())
        this.registerEditorContextActions(editor)
        this.registerEditorMouseSelectionFallback(editor)
    }

    private registerEditorContextActions (editor: any): void {
        if (!editor?.addAction || (editor as any).__tlinkEditorContextActionsRegistered) {
            return
        }
        editor.addAction({
            id: 'tlink.editor.addStickyNote',
            label: 'Add Sticky Note',
            contextMenuGroupId: '1_modification',
            contextMenuOrder: 2.95,
            run: async () => {
                await this.addEditorStickyNote(editor)
            },
        })
        ;(editor as any).__tlinkEditorContextActionsRegistered = true
    }

    private registerEditorMouseSelectionFallback (editor: any): void {
        if (!this.monaco || !editor?.onMouseDown) {
            return
        }
        const mouseTargetType = this.monaco.editor?.MouseTargetType
        const SelectionCtor = this.monaco.Selection
        if (!mouseTargetType || !SelectionCtor) {
            return
        }
        editor.onMouseDown((event: any) => {
            const model = editor.getModel?.()
            const targetType = event?.target?.type
            const lineNumber = event?.target?.position?.lineNumber
            if (!model || !Number.isFinite(lineNumber) || lineNumber < 1) {
                return
            }
            const browserEvent = event?.event?.browserEvent ?? event?.event ?? null
            const clickCount = Number(browserEvent?.detail ?? event?.event?.detail ?? 1)
            const isGutterClick = (
                targetType === mouseTargetType.GUTTER_LINE_NUMBERS
                || targetType === mouseTargetType.GUTTER_GLYPH_MARGIN
                || targetType === mouseTargetType.GUTTER_LINE_DECORATIONS
            )
            if (isGutterClick) {
                const anchorLine = this.editorLineSelectionAnchorByEditor.get(editor) ?? lineNumber
                if (browserEvent?.shiftKey) {
                    const startLine = Math.min(anchorLine, lineNumber)
                    const endLine = Math.max(anchorLine, lineNumber)
                    editor.setSelection(new SelectionCtor(startLine, 1, endLine, model.getLineMaxColumn(endLine)))
                } else {
                    this.editorLineSelectionAnchorByEditor.set(editor, lineNumber)
                    editor.setSelection(new SelectionCtor(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)))
                }
                return
            }

            this.editorLineSelectionAnchorByEditor.set(editor, lineNumber)
            const isContentClick = (
                targetType === mouseTargetType.CONTENT_TEXT
                || targetType === mouseTargetType.CONTENT_EMPTY
                || targetType === mouseTargetType.CONTENT_VIEW_ZONE
            )
            if (!isContentClick || clickCount < 2) {
                return
            }
            if (browserEvent?.shiftKey || browserEvent?.altKey || browserEvent?.metaKey || browserEvent?.ctrlKey) {
                return
            }
            window.requestAnimationFrame(() => {
                if (clickCount >= 3) {
                    editor.setSelection(new SelectionCtor(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)))
                    return
                }
                if (clickCount !== 2) {
                    return
                }
                const column = Math.max(1, Number(event?.target?.position?.column ?? 1))
                const word = model.getWordAtPosition({ lineNumber, column })
                if (!word || word.startColumn === word.endColumn) {
                    return
                }
                editor.setSelection(new SelectionCtor(lineNumber, word.startColumn, lineNumber, word.endColumn))
            })
        })
    }

    private nextUntitledName (folderPath?: string|null): string {
        const targetFolder = folderPath ?? this.selectedFolderPath ?? this.folderRoot
        let nextSeq = 1

        const collect = (rawName: string|null|undefined): void => {
            if (!rawName) {
                return
            }
            const match = /^Untitled-(\d+)$/i.exec(path.basename(rawName.trim()))
            if (!match) {
                return
            }
            const seq = Number.parseInt(match[1], 10)
            if (!Number.isNaN(seq) && seq >= nextSeq) {
                nextSeq = seq + 1
            }
        }

        for (const doc of this.documents) {
            collect(doc.name)
        }

        try {
            if (fsSync.existsSync(targetFolder) && fsSync.statSync(targetFolder).isDirectory()) {
                for (const name of fsSync.readdirSync(targetFolder)) {
                    collect(name)
                }
            }
        } catch {
            // ignore folder scan errors
        }

        while (nextSeq < 100000) {
            const candidate = `Untitled-${nextSeq}`
            const usedByDoc = this.documents.some(doc => doc.name === candidate)
            const usedOnDisk = fsSync.existsSync(path.join(targetFolder, candidate))
            if (!usedByDoc && !usedOnDisk) {
                return candidate
            }
            nextSeq++
        }

        return `Untitled-${Date.now()}`
    }

    private layoutEditors (): void {
        this.primaryEditor?.layout()
        this.splitEditor?.layout()
        this.diffEditor?.layout?.()
    }

    private startAutosave (): void {
        if (this.simpleDiskMode) {
            return
        }
        if (this.autosaveTimer) {
            clearInterval(this.autosaveTimer)
        }
        if (!this.autosaveEnabled) {
            return
        }
        this.autosaveTimer = window.setInterval(() => this.autosaveTick(), this.autosaveIntervalMs)
    }

    private async autosaveTick (): Promise<void> {
        // Snapshot the array — closeDocument replaces this.documents during
        // await yields, which could leave the for-of referencing stale docs.
        const snapshot = [...this.documents]
        for (const doc of snapshot) {
            // Re-check liveness: the doc may have been closed between awaits.
            if (!this.documents.includes(doc) || !this.isModelAlive(doc)) {
                continue
            }
            if (!doc.isDirty) {
                continue
            }
            if (doc.path) {
                if (this.isPathHiddenInTree(doc.path)) {
                    continue
                }
                await this.saveDocument(doc)
                continue
            }

            // Only autosave untitled docs that already have a tempPath.
            // The old code allocated a new tempPath here via
            // allocateTempPath, which could re-create deleted files
            // by picking the same name as a previously hidden file.
            // TempPaths are now allocated at creation time (newFile,
            // external hooks) so every doc that needs autosave will
            // already have one.
            if (!doc.tempPath) {
                continue
            }

            await this.saveTemp(doc)
            this.queuePersistState()
        }
    }

    private refreshDocDiskSnapshot (doc: EditorDocument, knownContent?: string): void {
        if (!doc.path) {
            doc.diskMtimeMs = null
            doc.diskSize = null
            return
        }
        try {
            const stat = fsSync.statSync(doc.path)
            if (!stat.isFile()) {
                return
            }
            doc.diskMtimeMs = stat.mtimeMs
            doc.diskSize = stat.size
            if (knownContent !== undefined) {
                doc.lastSavedValue = knownContent
            }
            doc.externalConflict = null
        } catch {
            // Ignore missing files while editor state settles.
        }
    }

    private startExternalChangeWatcher (): void {
        if (this.externalWatchTimer) {
            clearInterval(this.externalWatchTimer)
        }
        this.externalWatchTimer = window.setInterval(() => {
            void this.checkExternalChangeTick()
        }, this.externalWatchIntervalMs)
    }

    private async checkExternalChangeTick (): Promise<void> {
        if (this.externalWatchBusy) {
            return
        }
        this.externalWatchBusy = true
        let changed = false
        try {
            // Snapshot the array — closeDocument replaces this.documents
            // between await yields, which could expose stale/disposed docs.
            const snapshot = [...this.documents]
            for (const doc of snapshot) {
                // Re-check after each await: doc may have been closed.
                if (!this.documents.includes(doc) || !this.isModelAlive(doc)) {
                    continue
                }
                if (!doc.path) {
                    continue
                }
                const pathKey = this.getFsPathKey(doc.path)
                if (pathKey && this.deletingPathKeys.has(pathKey)) {
                    continue
                }
                let stat: fsSync.Stats
                try {
                    stat = fsSync.statSync(doc.path)
                    if (!stat.isFile()) {
                        continue
                    }
                } catch {
                    continue
                }

                const mtimeMs = stat.mtimeMs
                const size = stat.size
                if (doc.diskMtimeMs === mtimeMs && doc.diskSize === size) {
                    continue
                }

                let diskContent = ''
                try {
                    diskContent = await fs.readFile(doc.path, 'utf8')
                } catch {
                    continue
                }

                // Re-check liveness after async read — model may have been
                // disposed while we were reading from disk.
                if (!this.isModelAlive(doc)) {
                    continue
                }

                const modelValue = doc.model.getValue()
                if (diskContent === modelValue) {
                    doc.isDirty = false
                    doc.lastSavedValue = diskContent
                    doc.externalConflict = null
                    doc.diskMtimeMs = mtimeMs
                    doc.diskSize = size
                    this.updateTitle(doc)
                    changed = true
                    continue
                }

                if (doc.isDirty) {
                    doc.externalConflict = {
                        diskContent,
                        diskMtimeMs: mtimeMs,
                        diskSize: size,
                    }
                    doc.diskMtimeMs = mtimeMs
                    doc.diskSize = size
                    changed = true
                    continue
                }

                doc.externalConflict = null
                doc.lastSavedValue = diskContent
                doc.diskMtimeMs = mtimeMs
                doc.diskSize = size
                doc.model.setValue(diskContent)
                doc.isDirty = false
                this.updateTitle(doc)
                if (doc.id === this.activeDocId || doc.id === this.splitDocId) {
                    this.statusMessage = `Reloaded ${doc.name} from disk`
                    this.updateStatus()
                }
                changed = true
            }
        } finally {
            this.externalWatchBusy = false
        }
        if (changed) {
            this.cdr.markForCheck()
        }
    }

    async reloadActiveDocFromConflict (): Promise<void> {
        const doc = this.activeExternalConflictDoc
        if (!doc?.externalConflict || !this.isModelAlive(doc)) {
            return
        }
        const conflict = doc.externalConflict
        doc.lastSavedValue = conflict.diskContent
        doc.externalConflict = null
        doc.diskMtimeMs = conflict.diskMtimeMs
        doc.diskSize = conflict.diskSize
        doc.model.setValue(conflict.diskContent)
        doc.isDirty = false
        this.updateTitle(doc)
        this.statusMessage = `Reloaded ${doc.name} from disk`
        this.updateStatus()
        this.persistState()
        this.cdr.markForCheck()
    }

    keepActiveDocLocalChanges (): void {
        const doc = this.activeExternalConflictDoc
        if (!doc?.externalConflict) {
            return
        }
        doc.diskMtimeMs = doc.externalConflict.diskMtimeMs
        doc.diskSize = doc.externalConflict.diskSize
        doc.externalConflict = null
        this.statusMessage = `Keeping local changes for ${doc.name}`
        this.updateStatus()
        this.persistState()
        this.cdr.markForCheck()
    }

    compareActiveDocWithConflictDisk (): void {
        const doc = this.activeExternalConflictDoc
        if (!doc?.externalConflict) {
            return
        }
        this.enterDiff(doc, doc.externalConflict.diskContent, `${doc.name} (disk changed)`)
    }

    private getAutosaveTargetFolder (): string {
        this.ensureWorkspaceRootAttached()
        const selectedFile = this.getSelectedFilePathsFromTree()[0]
        if (selectedFile) {
            return this.resolveFolderCreationParent(path.dirname(selectedFile))
        }
        return this.resolveFolderCreationParent(this.selectedFolderPath ?? this.folderRoot)
    }

    async newFile (): Promise<void> {
        if (!(await this.ensureEditor())) {
            return
        }
        try {
            const targetFolder = this.getAutosaveTargetFolder()
            const name = this.nextUntitledName(targetFolder)
            const targetPath = path.join(targetFolder, name)
            await fs.mkdir(targetFolder, { recursive: true })
            await fs.writeFile(targetPath, '', 'utf8')
            this.openDocumentFromContent(path.basename(targetPath), targetPath, '')
            this.persistState()
            this.updateTreeItems()
            window.setTimeout(() => this.cdr.markForCheck(), 0)
        } catch (err: any) {
            console.error('[newFile] Failed:', err)
            this.setError(`Failed to create new file: ${err?.message ?? err}`)
        }
    }

    private queuePersistState (): void {
        if (this.persistStateTimer) {
            clearTimeout(this.persistStateTimer)
        }
        this.persistStateTimer = window.setTimeout(() => {
            this.persistStateTimer = undefined
            this.persistState()
        }, 250)
    }

    private persistState (): void {
        this.syncOpenedFileScopes()
        // Flush any pending debounced folder write so that
        // the full state snapshot is consistent.
        if (this.persistFoldersTimer) {
            clearTimeout(this.persistFoldersTimer)
            this.persistFoldersTimer = undefined
        }
        this.flushPersistFolders()
        // Filter out docs whose models were disposed (e.g., during restoreState
        // cleanup) to prevent "Model is disposed" errors.
        // Also filter out docs whose path/tempPath is in hiddenTreePathKeys
        // as a belt-and-suspenders guard — closeDocument removes them from
        // this.documents, but if a race condition or exception prevented
        // that removal, this filter prevents them from being persisted.
        const liveDocs = this.documents.filter(doc => {
            if (!this.isModelAlive(doc)) {
                return false
            }
            const docKey = this.toTreePathKey(doc.path ?? doc.tempPath ?? null)
            if (docKey && this.hiddenTreePathKeys.has(docKey)) {
                return false
            }
            return true
        })
        const docState = liveDocs.map(doc => this.snapshotDocument(doc))
        const active = this.activeDocId
        this.setStateItem('codeEditor.recent', JSON.stringify(this.recentFiles.slice(0, 10)))
        this.setStateItem('codeEditor.docs', JSON.stringify(docState))
        this.setStateItem('codeEditor.active', active ?? '')
        this.setStateItem('codeEditor.themeMode', this.themeMode)
        this.setStateItem('codeEditor.themeColor', this.editorThemeColor)
        this.setStateItem('codeEditor.split', this.splitEditor ? '1' : '')
        this.setStateItem('codeEditor.splitDoc', this.splitDocId ?? '')
        this.setStateItem('codeEditor.sidebarWidth', String(this.sidebarWidth))
        this.setStateItem('codeEditor.wordWrap', this.wordWrapEnabled ? '1' : '')
        this.setStateItem('codeEditor.minimap', this.minimapEnabled ? '1' : '')
        this.setStateItem('codeEditor.fontSize', String(this.fontSize))
        this.setStateItem('codeEditor.lineHeight', String(this.lineHeight))
        this.setStateItem('codeEditor.autosave', this.autosaveEnabled ? '1' : '')
        // NOTE: Do NOT call queueSaveTemp here.  The old code
        // looped over this.documents and queued temp saves for
        // every untitled doc, but persistState is called during
        // startup (right after restoreState) and from many other
        // places.  Triggering file writes from persistState
        // caused deleted untitled files to be re-created on disk
        // after restart.  Temp-file writes are now only triggered
        // by content changes (onDidChangeContent → queueSaveTemp)
        // and by autosaveTick for docs that already have a tempPath.
        this.recoveryStateChangedHint.next()
    }

    private allocateTempPath (name: string, folderPath?: string|null): string {
        // Always resolve against the current workspace root so temp files
        // stay inside the tree that buildTree/readDir scans.  Using a
        // separate getTempDir() would put them in a directory the tree
        // never reads, causing hiddenTreePathKeys mismatches on restart.
        const workspaceRoot = path.resolve(this.folderRoot)
        let base = folderPath ?? workspaceRoot
        try {
            fsSync.mkdirSync(base, { recursive: true })
        } catch {
            base = workspaceRoot
            try {
                fsSync.mkdirSync(base, { recursive: true })
            } catch {
                // best effort
            }
        }
        const compactName = this.toCompactAutoFileName(name || 'untitled.txt')
        const ext = path.extname(compactName)
        const stem = path.basename(compactName, ext) || 'untitled'
        let candidate = path.join(base, compactName)
        let index = 1
        while (fsSync.existsSync(candidate) && index < 1000) {
            candidate = path.join(base, `${stem}-${index}${ext}`)
            index++
        }
        if (fsSync.existsSync(candidate)) {
            candidate = path.join(base, `${stem}-${Date.now().toString(36)}${ext}`)
        }
        // NOTE: Do NOT call revealTreePath here.  The old code
        // automatically un-hid the candidate path, but that caused
        // deleted untitled files to reappear on restart: autosaveTick
        // would allocate a tempPath with the same name as a hidden
        // (deleted) file, revealTreePath removed the hidden entry,
        // and saveTemp then re-created the file on disk.
        //
        // Callers that genuinely create a *new* user-facing file
        // (e.g. newFile()) should call revealTreePath themselves
        // after allocating the path.
        return candidate
    }

    private toCompactAutoFileName (rawName: string): string {
        const baseNameRaw = path.basename((rawName ?? '').trim() || 'untitled.txt')
        const cleaned = baseNameRaw
            .replace(/[\\/\u0000-\u001f]/g, '_')
            .replace(/^\.+$/, 'untitled')
            .trim() || 'untitled.txt'
        // Strip previous auto-generated prefix like "<timestamp>-<token>-"
        const withoutGeneratedPrefix = cleaned.replace(/^\d{10,}-[a-f0-9]{6,}-/i, '')
        const ext = path.extname(withoutGeneratedPrefix).slice(0, 20)
        let stem = path.basename(withoutGeneratedPrefix, ext)
        if (!stem) {
            stem = 'untitled'
        }
        const maxStem = 48
        if (stem.length > maxStem) {
            const head = stem.slice(0, 28)
            const tail = stem.slice(-12)
            stem = `${head}~${tail}`
        }
        return `${stem}${ext}`
    }

    private getTempDir (): string {
        return this.resolveStudioDir('tlink-studio-temp', 'code-editor-temp')
    }

    private queueSaveTemp (doc: EditorDocument): void {
        if (this.simpleDiskMode) {
            return
        }
        if (!doc.tempPath) {
            return
        }
        const tempKey = this.toTreePathKey(doc.tempPath)
        // Hard block: path was deleted during this session.
        if (tempKey && this.deletedTempPaths.has(tempKey)) {
            return
        }
        // Don't schedule saves for paths that have been hidden/deleted.
        if (this.isPathHiddenInTree(doc.tempPath)) {
            return
        }
        const existing = this.tempSaveTimers.get(doc.id)
        if (existing) {
            clearTimeout(existing)
        }
        const timer = window.setTimeout(() => {
            this.tempSaveTimers.delete(doc.id)
            if (!this.documents.some(d => d.id === doc.id)) {
                return
            }
            this.saveTemp(doc).catch(() => null)
        }, 500)
        this.tempSaveTimers.set(doc.id, timer)
    }

    private async saveTemp (doc: EditorDocument): Promise<void> {
        if (this.simpleDiskMode) {
            return
        }
        if (!doc.tempPath) {
            return
        }
        const tempKey = this.toTreePathKey(doc.tempPath)
        // Hard block: path was deleted during this session.
        if (tempKey && this.deletedTempPaths.has(tempKey)) {
            return
        }
        // Abort if the path was hidden (document was closed/deleted).
        if (this.isPathHiddenInTree(doc.tempPath)) {
            return
        }
        // Abort if the doc is no longer in the documents list.
        if (!this.documents.includes(doc)) {
            return
        }
        if (!this.isModelAlive(doc)) {
            return
        }
        const tempPath = doc.tempPath
        let existedBefore = false
        try {
            existedBefore = fsSync.existsSync(tempPath)
        } catch {
            existedBefore = false
        }
        try {
            await fs.mkdir(path.dirname(tempPath), { recursive: true })
            await fs.writeFile(tempPath, doc.model.getValue(), 'utf8')
            if (!existedBefore) {
                this.updateTreeItems()
                window.setTimeout(() => this.cdr.markForCheck(), 0)
            }
        } catch {
            // best-effort temp save
        }
    }

    private async deleteTemp (tempPath: string): Promise<void> {
        try {
            await fs.unlink(tempPath)
        } catch {
            // ignore
        }
    }

    private async restoreState (): Promise<void> {
        this.recentFiles = this.loadRecent()
        const savedTheme = this.getStateItem('codeEditor.themeMode') as (EditorThemeMode|null)
        if (savedTheme && this.supportedThemeModes.includes(savedTheme)) {
            this.themeMode = savedTheme
        }
        const savedThemeColor = this.getStateItem('codeEditor.themeColor')
        if (savedThemeColor) {
            this.editorThemeColor = this.normalizeHexColor(savedThemeColor, this.editorThemeColor)
        }
        const savedSidebar = this.getStateItem('codeEditor.sidebarWidth')
        if (savedSidebar) {
            const parsed = parseInt(savedSidebar, 10)
            if (!isNaN(parsed) && parsed >= 160 && parsed <= 480) {
                this.sidebarWidth = parsed
            }
        }
        const savedWordWrap = this.getStateItem('codeEditor.wordWrap')
        if (savedWordWrap !== null) {
            this.wordWrapEnabled = savedWordWrap === '1'
        }
        const savedMinimap = this.getStateItem('codeEditor.minimap')
        if (savedMinimap !== null) {
            this.minimapEnabled = savedMinimap === '1'
        }
        const savedFontSize = this.getStateItem('codeEditor.fontSize')
        if (savedFontSize) {
            const parsed = parseInt(savedFontSize, 10)
            if (!isNaN(parsed) && parsed >= 10 && parsed <= 28) {
                this.fontSize = parsed
            }
        }
        const savedLineHeight = this.getStateItem('codeEditor.lineHeight')
        if (savedLineHeight) {
            const parsed = parseInt(savedLineHeight, 10)
            if (!isNaN(parsed) && parsed >= 14 && parsed <= 40) {
                this.lineHeight = parsed
            }
        }
        const savedAutosave = this.getStateItem('codeEditor.autosave')
        if (savedAutosave !== null) {
            this.autosaveEnabled = savedAutosave === '1'
        }
        this.primaryEditor?.updateOptions({
            wordWrap: this.wordWrapEnabled ? 'on' : 'off',
            minimap: { enabled: this.minimapEnabled },
            fontSize: this.fontSize,
            lineHeight: this.lineHeight,
        })
        this.splitEditor?.updateOptions({
            wordWrap: this.wordWrapEnabled ? 'on' : 'off',
            minimap: { enabled: this.minimapEnabled },
            fontSize: this.fontSize,
            lineHeight: this.lineHeight,
        })
        if (this.simpleDiskMode) {
            this.autosaveEnabled = false
            this.setStateItem('codeEditor.autosave', '')
            this.setStateItem('codeEditor.docs', '[]')
            this.setStateItem('codeEditor.active', '')
            this.setStateItem('codeEditor.split', '')
            this.setStateItem('codeEditor.splitDoc', '')
            // In simple mode the tree must reflect disk exactly.
            // Clear persisted hidden paths so previously closed/hidden
            // files never disappear from the tree on restart.
            this.hiddenTreePathKeys = new Set()
            this.setStateItem('codeEditor.hiddenTreePaths', '[]')
            return
        }
        const splitEnabled = this.getStateItem('codeEditor.split') === '1'
        const savedSplitDoc = this.getStateItem('codeEditor.splitDoc') || null
        const raw = this.getStateItem('codeEditor.docs')
        if (!raw) {
            return
        }
        try {
            // Cancel any pending debounced persist so it doesn't fire
            // after we dispose the old models (would hit "Model is disposed").
            if (this.persistStateTimer) {
                clearTimeout(this.persistStateTimer)
                this.persistStateTimer = undefined
            }
            // Dispose any existing tracked documents/models before restoring
            // to prevent listener accumulation across re-initializations.
            // NOTE: Do NOT dispose orphaned global Monaco models here — that
            // would destroy the primaryEditor's own model while the editor
            // is live, breaking it. Orphan cleanup is done in ngOnDestroy.
            if (this.documents.length) {
                this.disposeModels()
            }
            const docs: EditorDocumentSnapshot[] = JSON.parse(raw)
            // Cap restored documents to prevent creating excessive Monaco models
            // which accumulate internal listener registrations.
            const MAX_RESTORED_DOCS = 50
            let restoredCount = 0
            for (const snap of docs) {
                if (restoredCount >= MAX_RESTORED_DOCS) {
                    console.warn(`[restoreState] Capped at ${MAX_RESTORED_DOCS} restored docs (${docs.length} saved)`)
                    break
                }
                // Skip docs whose backing file was deleted from disk OR
                // whose path was explicitly hidden (e.g. the user deleted
                // the file but the app was killed before fs.unlink /
                // persistState could complete).
                if (snap.path) {
                    const pathKey = this.toTreePathKey(snap.path)
                    if (pathKey && this.hiddenTreePathKeys.has(pathKey)) {
                        continue
                    }
                    try {
                        if (!fsSync.existsSync(snap.path)) {
                            continue
                        }
                    } catch {
                        continue
                    }
                }
                // Skip orphan docs: no saved path AND no temp path means
                // the doc was captured mid-close (tempPath already nulled
                // but doc not yet removed from the list).  Restoring it
                // would cause autosaveTick to allocate a new tempPath
                // via allocateTempPath → revealTreePath, which removes
                // the hidden entry and re-creates the file on disk.
                if (!snap.path && !snap.tempPath) {
                    continue
                }
                // Skip untitled docs whose temp path was hidden (i.e. the
                // user explicitly closed/deleted it). The hiding action is
                // the authoritative signal — don't require the temp file to
                // also be gone from disk, because deleteTemp may have failed.
                if (!snap.path && snap.tempPath) {
                    const tempKey = this.toTreePathKey(snap.tempPath)
                    if (tempKey && this.hiddenTreePathKeys.has(tempKey)) {
                        continue
                    }
                }
                // Additional guard: check if the doc name matches any
                // hidden path in the current workspace root. This catches
                // cases where tempPath was nulled in closeDocument but the
                // snapshot was serialised before the doc was removed.
                if (!snap.path && snap.name) {
                    const candidatePath = path.join(
                        snap.folderPath ?? this.selectedFolderPath ?? path.resolve(this.folderRoot),
                        snap.name,
                    )
                    const candidateKey = this.toTreePathKey(candidatePath)
                    if (candidateKey && this.hiddenTreePathKeys.has(candidateKey)) {
                        continue
                    }
                }
                // Definitive guard: if the untitled doc's temp file was
                // deleted from disk (by closeDocument's unlinkSync), the
                // doc was explicitly closed.  Do NOT restore it — doing
                // so would cause autosaveTick / queueSaveTemp to re-create
                // the file on disk.
                if (!snap.path && snap.tempPath) {
                    try {
                        if (!fsSync.existsSync(snap.tempPath)) {
                            continue
                        }
                    } catch {
                        continue
                    }
                }
                let snapContent = snap.content
                if (!snap.path && snap.tempPath && fsSync.existsSync(snap.tempPath)) {
                    try {
                        snapContent = fsSync.readFileSync(snap.tempPath, 'utf8')
                    } catch {
                        // ignore temp read errors
                    }
                }
                const doc = this.createDocument({ ...snap, content: snapContent })
                doc.lastSavedValue = snap.lastSavedValue ?? snapContent
                this.refreshDocDiskSnapshot(doc, snapContent)
                this.documents.push(doc)
                restoredCount++
            }
            let folderStateChanged = this.syncOpenedFileScopes()
            // Activate a document. The saved activeId uses old IDs from the
            // previous session, but createDocument generates new IDs, so the
            // lookup may fail.  Always fall through to activate the first doc.
            const activeId = this.getStateItem('codeEditor.active')
            let activated = false
            if (activeId) {
                const found = this.documents.find(d => d.id === activeId)
                if (found) {
                    this.activateDoc(activeId)
                    activated = true
                }
            }
            if (!activated && this.documents.length) {
                this.activateDoc(this.documents[0].id)
            }
            if (splitEnabled) {
                this.pendingSplitDocId = savedSplitDoc || this.activeDocId || (this.documents[0]?.id ?? null)
            }
            if (this.hydrateScopedRootsFromOpenDocuments()) {
                folderStateChanged = true
            }
            if (folderStateChanged) {
                this.persistFolders()
            }
            // Clear ALL hiddenTreePathKeys on restart.
            //
            // hiddenTreePathKeys was previously used for two
            // purposes:
            //   1. Defence against deleted-file re-creation
            //   2. Hiding items the user closed from the tree
            //
            // Purpose 1 is now handled by other guards:
            //   • deletedTempPaths session kill-list
            //   • restoreState temp-file-existence check
            //   • autosaveTick no longer allocates new tempPaths
            //   • persistState no longer triggers queueSaveTemp
            //   • allocateTempPath no longer calls revealTreePath
            //
            // Purpose 2 only needs to last for the current session.
            // Persisting it caused files/folders (e.g. Folder3/
            // Untitled-1) to stay hidden across restarts even
            // though they exist on disk.  Clearing on restart
            // gives a clean slate — the tree shows everything
            // on disk.  Deleted temp files won't reappear because
            // they no longer exist on disk.
            if (this.hiddenTreePathKeys.size) {
                this.hiddenTreePathKeys = new Set()
                this.persistFolders()
            }
        } catch {
            // ignore corrupted state
        }
    }

    private loadRecent (): string[] {
        try {
            return JSON.parse(this.getStateItem('codeEditor.recent') ?? '[]') ?? []
        } catch {
            return []
        }
    }

    private rememberRecent (filePath: string): void {
        this.recentFiles = [filePath, ...this.recentFiles.filter(f => f !== filePath)].slice(0, 10)
        this.setStateItem('codeEditor.recent', JSON.stringify(this.recentFiles))
    }

    private getActiveEditor (): any {
        if (this.viewMode === 'diff') {
            return this.diffEditor
        }
        if (this.splitEditor?.hasTextFocus?.()) {
            return this.splitEditor
        }
        if (this.primaryEditor?.hasTextFocus?.()) {
            return this.primaryEditor
        }
        if (this.focusedEditor === 'split' && this.splitEditor) {
            return this.splitEditor
        }
        return this.primaryEditor
    }

    refreshActiveDocCache (): void {
        this.cachedActiveDoc = this.getActiveDoc()
    }

    private getActiveDoc (): EditorDocument|null {
        if (this.viewMode === 'editor') {
            if (this.splitEditor?.hasTextFocus?.() && this.splitDocId) {
                return this.documents.find(d => d.id === this.splitDocId) ?? null
            }
            if (this.primaryEditor?.hasTextFocus?.() && this.activeDocId) {
                return this.documents.find(d => d.id === this.activeDocId) ?? null
            }
            if (this.focusedEditor === 'split' && this.splitDocId) {
                return this.documents.find(d => d.id === this.splitDocId) ?? null
            }
        }
        if (!this.activeDocId) {
            return null
        }
        return this.documents.find(d => d.id === this.activeDocId) ?? null
    }

    private disposeEditors (): void {
        this.primaryEditor?.dispose?.()
        this.splitEditor?.dispose?.()
        this.diffEditor?.dispose?.()
    }

    private disposeModels (): void {
        this.documents.forEach(doc => {
            doc.modelDisposables?.forEach(d => d.dispose?.())
            doc.modelDisposables = []
            doc.model?.dispose?.()
        })
        this.documents = []
    }

    /** Returns true if the doc's Monaco model is still usable (not disposed). */
    private isModelAlive (doc: EditorDocument): boolean {
        if (!doc?.model) { return false }
        try { doc.model.getVersionId(); return true } catch { return false }
    }

    private updateTitle (doc: EditorDocument): void {
        const suffix = doc.isDirty ? ' •' : ''
        this.setTitle(`${doc.name}${suffix}`)
    }

    private enterDiff (doc: EditorDocument, originalContent: string, label: string): void {
        if (!this.monaco || !this.diffHost) {
            return
        }
        this.viewMode = 'diff'
        this.diffEditor?.dispose?.()
        this.diffOriginalModel?.dispose?.()
        this.diffOriginalModel = this.monaco.editor.createModel(originalContent, this.pickLanguage(doc.name))
        this.diffEditor = this.monaco.editor.createDiffEditor(this.diffHost.nativeElement, {
            ...this.editorOptions(),
            renderSideBySide: true,
        })
        this.diffEditor.setModel({
            original: this.diffOriginalModel,
            modified: doc.model,
        })
        this.diffEditor.updateOptions({ readOnly: false })
        this.diffEditor.modifiedEditor?.updateOptions?.({ readOnly: false })
        this.diffEditor.originalEditor?.updateOptions?.({ readOnly: true })
        this.statusMessage = `Comparing against ${label}`
        this.layoutEditors()
    }

    /**
     * Fatal error — prevents all future editor operations.
     * Only use during initialization when the editor cannot function.
     */
    private setFatalError (message: string): void {
        this.loadError = message
        this.loading = false
    }

    /**
     * Non-fatal operational error — shows a temporary error message
     * but does NOT set loadError, so file operations keep working.
     */
    private setError (message: string): void {
        this.statusMessage = `Error: ${message}`
        this.updateStatus()
        window.setTimeout(() => this.cdr.markForCheck(), 0)
    }

    @HostListener('document:click', ['$event'])
    closeEditMenu (event?: MouseEvent): void {
        const target = (event?.target ?? null) as any
        if (!target?.closest?.('.tab-sidebar')) {
            this.treeKeyboardActive = false
        }
        if (!target?.closest?.('.diagnostics-panel') && !target?.closest?.('.diagnostics-toggle')) {
            this.showDiagnostics = false
        }
        // Don't close menus when clicking inside them.
        // Note: this also protects against capture-phase document listeners closing the menu
        // before the menu item's click handler runs.
        if (target?.closest?.('.doc-context-menu') || target?.closest?.('.menu-container')) {
            return
        }
        // Clear folder selection when clicking anywhere outside actual tree rows,
        // including empty area inside the left tree pane.
        if (!target?.closest?.('.tree-row')) {
            this.clearFolderSelectionOnly()
        }
        // Close all context menus
        this.cancelEditMenuClose()
        this.cancelFileMenuClose()
        this.editMenuOpen = false
        this.fileMenuOpen = false
        this.docContextMenuOpen = false
        this.folderContextMenuOpen = false
        this.fileContextMenuOpen = false
        this.topologyContextMenuOpen = false
        this.topologyNodeContextMenuOpen = false
        // Clear menu state
        this.docContextMenuDocId = null
        this.folderContextMenuPath = null
        this.folderContextMenuPaths = []
        this.folderContextScopeRoot = null
        this.folderContextScopeMode = 'full'
        this.fileContextMenuPath = null
        this.fileContextMenuPaths = []
        this.topologyContextMenuPoint = null
        this.topologyNodeContextMenuNodeId = null
    }

    @HostListener('document:contextmenu', ['$event'])
    closeContextMenusOnRightClick (event?: MouseEvent): void {
        const target = (event?.target ?? null) as any
        // Don't close if right-clicking on a menu or menu trigger
        if (target?.closest?.('.doc-context-menu') || target?.closest?.('.menu-container') || target?.closest?.('.tree-row')) {
            return
        }
        // Close all context menus when right-clicking elsewhere
        this.docContextMenuOpen = false
        this.folderContextMenuOpen = false
        this.fileContextMenuOpen = false
        this.topologyContextMenuOpen = false
        this.topologyNodeContextMenuOpen = false
        this.docContextMenuDocId = null
        this.folderContextMenuPath = null
        this.folderContextMenuPaths = []
        this.folderContextScopeRoot = null
        this.folderContextScopeMode = 'full'
        this.fileContextMenuPath = null
        this.fileContextMenuPaths = []
        this.topologyContextMenuPoint = null
        this.topologyNodeContextMenuNodeId = null
    }

    @HostListener('document:mousemove', ['$event'])
    onSidebarDrag (event: MouseEvent): void {
        if (!this.topologyPanDragActive && !this.topologyFreeLinkCreating && !this.topologyMarqueeActive && !this.topologyResizeNodeId && !this.topologyDragNodeId && !this.topologyDragFreeLinkId && !this.topologyResizeTextId && !this.topologyDragTextId && !this.topologyResizeShapeId && !this.topologyDragShapeId && !this.resizingSidebar) {
            return
        }
        if (this.mousemoveRafPending) {
            return
        }
        this.mousemoveRafPending = true
        requestAnimationFrame(() => {
            this.mousemoveRafPending = false
            this.handleMousemove(event)
        })
    }

    private handleMousemove (event: MouseEvent): void {
        if (this.topologyPanDragActive) {
            this.updateTopologyPanDrag(event)
            return
        }
        if (this.topologyFreeLinkCreating) {
            this.updateTopologyFreeLinkDraft(event)
            return
        }
        if (this.topologyMarqueeActive) {
            this.updateTopologyMarquee(event)
            return
        }
        if (this.topologyResizeNodeId) {
            this.moveTopologyResizeNode(event)
            return
        }
        if (this.topologyDragNodeId) {
            this.moveTopologyDragNode(event)
            return
        }
        if (this.topologyDragFreeLinkId) {
            this.moveTopologyFreeLinkHandleDrag(event)
            return
        }
        if (this.topologyResizeTextId) {
            this.moveTopologyResizeText(event)
            return
        }
        if (this.topologyDragTextId) {
            this.moveTopologyDragText(event)
            return
        }
        if (this.topologyResizeShapeId) {
            this.moveTopologyResizeShape(event)
            return
        }
        if (this.topologyDragShapeId) {
            this.moveTopologyDragShape(event)
            return
        }
        if (!this.resizingSidebar) {
            return
        }
        const delta = event.clientX - this.resizeStartX
        const next = Math.min(480, Math.max(160, this.resizeStartWidth + delta))
        if (next !== this.sidebarWidth) {
            this.sidebarWidth = next
            this.layoutEditors()
        }
    }

    @HostListener('document:mouseup')
    endSidebarDrag (): void {
        if (this.topologyPanDragActive) {
            this.finishTopologyPanDrag()
        }
        if (this.topologyFreeLinkCreating) {
            this.finishTopologyFreeLinkDraft()
        }
        if (this.topologyMarqueeActive) {
            this.finishTopologyMarquee()
        }
        if (this.topologyResizeNodeId) {
            this.topologyResizeNodeId = null
            if (this.topologyNodeResizeChanged) {
                this.topologyNodeResizeChanged = false
                this.persistTopologyToDoc()
            }
            this.cdr.markForCheck()
        }
        if (this.topologyDragNodeId) {
            this.topologyDragNodeId = null
            if (this.topologyDragChanged) {
                this.topologyDragChanged = false
                this.persistTopologyToDoc()
            }
            this.cdr.markForCheck()
        }
        if (this.topologyDragFreeLinkId) {
            this.topologyDragFreeLinkId = null
            this.topologyDragFreeLinkHandle = null
            this.topologyFreeLinkMoveStartPointerX = 0
            this.topologyFreeLinkMoveStartPointerY = 0
            this.topologyFreeLinkMoveStartX1 = 0
            this.topologyFreeLinkMoveStartY1 = 0
            this.topologyFreeLinkMoveStartX2 = 0
            this.topologyFreeLinkMoveStartY2 = 0
            if (this.topologyFreeLinkHandleDragChanged) {
                this.topologyFreeLinkHandleDragChanged = false
                this.persistTopologyToDoc()
            }
            this.cdr.markForCheck()
        }
        if (this.topologyDragTextId) {
            this.topologyDragTextId = null
            if (this.topologyTextDragChanged) {
                this.topologyTextDragChanged = false
                this.persistTopologyToDoc()
            }
            this.cdr.markForCheck()
        }
        if (this.topologyResizeTextId) {
            this.topologyResizeTextId = null
            if (this.topologyTextResizeChanged) {
                this.topologyTextResizeChanged = false
                this.persistTopologyToDoc()
            }
            this.cdr.markForCheck()
        }
        if (this.topologyResizeShapeId) {
            this.topologyResizeShapeId = null
            if (this.topologyShapeResizeChanged) {
                this.topologyShapeResizeChanged = false
                this.persistTopologyToDoc()
            }
            this.cdr.markForCheck()
        }
        if (this.topologyDragShapeId) {
            this.topologyDragShapeId = null
            if (this.topologyShapeDragChanged) {
                this.topologyShapeDragChanged = false
                this.persistTopologyToDoc()
            }
            this.cdr.markForCheck()
        }
        this.clearTopologyPointerSpaceCache()
        if (!this.resizingSidebar) {
            return
        }
        this.resizingSidebar = false
        this.persistState()
    }

    @HostListener('window:resize')
    onWindowResize (): void {
        if (this.resizeRafPending) {
            return
        }
        this.resizeRafPending = true
        requestAnimationFrame(() => {
            this.resizeRafPending = false
            this.layoutEditors()
            this.updateVisibleTreeItems(true)
            this.cdr.markForCheck()
        })
    }

    private parseAnsi (input: string): { text: string, segments: Array<{ start: number, end: number, classes: string }> } {
        const ESC = '\u001b['
        let i = 0
        let clean = ''
        const segments: Array<{ start: number, end: number, classes: string }> = []
        let activeStart = 0
        let fg: string|null = null
        let bg: string|null = null
        let bold = false
        let underline = false

        const pushSegment = (end: number) => {
            if (end > activeStart && (fg || bg || bold || underline)) {
                const classes = [
                    fg ? `ansi-fg-${fg}` : '',
                    bg ? `ansi-bg-${bg}` : '',
                    bold ? 'ansi-bold' : '',
                    underline ? 'ansi-underline' : '',
                ].filter(Boolean).join(' ')
                segments.push({ start: activeStart, end, classes })
            }
            activeStart = end
        }

        const setSgr = (codes: number[]) => {
            for (const code of codes) {
                if (code === 0) {
                    pushSegment(clean.length)
                    fg = bg = null
                    bold = underline = false
                    continue
                }
                if (code === 1) bold = true
                if (code === 4) underline = true
                if (code === 22) bold = false
                if (code === 24) underline = false
                if (code === 49) {
                    pushSegment(clean.length)
                    bg = null
                    continue
                }
                if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
                    const map: Record<number, string> = {
                        30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
                        90: 'brblack', 91: 'brred', 92: 'brgreen', 93: 'bryellow', 94: 'brblue', 95: 'brmagenta', 96: 'brcyan', 97: 'brwhite',
                    }
                    pushSegment(clean.length)
                    fg = map[code] ?? fg
                }
                if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
                    /*
                     * Ignore ANSI background colors in the editor to keep selection
                     * and search highlights readable and consistent across themes.
                     */
                    continue
                }
            }
        }

        while (i < input.length) {
            const escPos = input.indexOf(ESC, i)
            if (escPos === -1) {
                clean += input.slice(i)
                break
            }
            clean += input.slice(i, escPos)
            i = escPos + ESC.length
            const mPos = input.indexOf('m', i)
            if (mPos === -1) {
                break
            }
            const seq = input.slice(i, mPos)
            const codes = seq.split(';').filter(Boolean).map(x => parseInt(x, 10)).filter(x => !isNaN(x))
            pushSegment(clean.length)
            setSgr(codes.length ? codes : [0])
            i = mPos + 1
        }
        pushSegment(clean.length)
        return { text: clean, segments }
    }

    private offsetToPosition (text: string): Array<{ start: number, line: number, col: number }> {
        const map: Array<{ start: number, line: number, col: number }> = []
        let line = 1
        let col = 1
        map.push({ start: 0, line, col })
        for (let idx = 0; idx < text.length; idx++) {
            const ch = text[idx]
            if (ch === '\n') {
                line++
                col = 1
                map.push({ start: idx + 1, line, col })
            } else {
                col++
            }
        }
        return map
    }

    private applyAnsiDecorations (doc: EditorDocument, rawContent: string): void {
        if (!this.monaco || !doc.model || !this.isModelAlive(doc)) {
            return
        }
        const { text, segments } = this.parseAnsi(rawContent)
        doc.model.setValue(text)
        this.setModelLanguage(doc)
        const lineMap = this.offsetToPosition(text)

        const findLine = (offset: number) => {
            let lo = 0
            let hi = lineMap.length - 1
            while (lo <= hi) {
                const mid = Math.floor((lo + hi) / 2)
                if (lineMap[mid].start <= offset && (mid === lineMap.length - 1 || lineMap[mid + 1].start > offset)) {
                    return lineMap[mid]
                }
                if (lineMap[mid].start > offset) {
                    hi = mid - 1
                } else {
                    lo = mid + 1
                }
            }
            return lineMap[0]
        }

        const decorations = segments.map(seg => {
            const startPos = findLine(seg.start)
            const endPos = findLine(seg.end)
            const startColumn = startPos.col + (seg.start - startPos.start)
            const endColumn = endPos.col + (seg.end - endPos.start)
            return {
                range: new this.monaco.Range(startPos.line, startColumn, endPos.line, endColumn),
                options: { inlineClassName: seg.classes },
            }
        })
        doc.ansiDecorationIds = doc.model.deltaDecorations(doc.ansiDecorationIds ?? [], decorations)
    }

    private async ensureRunTerminal (cwd: string): Promise<BaseTerminalTabComponentType | null> {
        const terminalService = this.resolveTerminalService()
        if (!terminalService) {
            return null
        }
        const existing = this.runTerminalTab as (BaseTerminalTabComponentType & BaseTabComponent) | null
        if (existing?.parent) {
            return existing
        }
        const runProfile = await this.resolveRunProfile()
        const term = await terminalService.openTab(runProfile, cwd, false)
        if (!term) {
            return null
        }
        // Mark this terminal as a dedicated "Run in terminal" pane so the terminal plugin can
        // show a close button inside the pane without affecting regular split panes.
        ;(term as any).__tlinkRunTerminal = true
        // Make sure the terminal toolbar (which contains the split-pane close button) is visible
        // for the code editor run terminal. Regular terminals can keep their default behavior.
        try {
            ;(term as any).enableToolbar = true
            ;(term as any).pinToolbar = true
            ;(term as any).revealToolbar = true
        } catch {}
        this.runTerminalTab = term
        ;(term as any).destroyed$?.subscribe(() => {
            if (this.runTerminalTab === term) {
                this.runTerminalTab = null
            }
        })
        await this.placeTerminalNextToEditor(term)
        return term
    }

    private async placeTerminalNextToEditor (term: BaseTerminalTabComponentType): Promise<void> {
        const terminalTab = term as BaseTerminalTabComponentType & BaseTabComponent
        if (terminalTab.parent === this.parent && terminalTab.parent instanceof SplitTabComponent) {
            terminalTab.parent.focus(terminalTab)
            return
        }
        if (this.parent instanceof SplitTabComponent) {
            // Prefer a bottom "console" layout for running code
            await this.parent.addTab(terminalTab, this, 'b')
            this.parent.focus(terminalTab)
            return
        }
        const idx = this.app.tabs.indexOf(this)
        this.app.removeTab(this)
        const split = this.tabsService.create({ type: SplitTabComponent })
        await split.addTab(this, null, 't')
        await split.addTab(terminalTab, this, 'b')
        this.app.addTabRaw(split, idx >= 0 ? idx : null)
        this.app.selectTab(split)
    }

    private sendToTerminal (term: BaseTerminalTabComponentType, text: string): void {
        const terminal = term as any
        const payload = Buffer.from(text)

        const sendNow = (): boolean => {
            try {
                if (terminal?.session?.open && typeof terminal.sendInput === 'function') {
                    terminal.sendInput(text)
                    return true
                }
                if (terminal?.session?.open && typeof terminal.session?.write === 'function') {
                    terminal.session.write(payload)
                    return true
                }
            } catch {
                // Retry through sessionChanged$ fallback below.
            }
            return false
        }

        if (sendNow()) {
            return
        }

        const sessionChanged$ = terminal?.sessionChanged$
        if (sessionChanged$?.subscribe) {
            const subscription = sessionChanged$.subscribe((session: any) => {
                if (!session?.open) {
                    return
                }
                try {
                    if (typeof terminal.sendInput === 'function') {
                        terminal.sendInput(text)
                    } else if (typeof session?.write === 'function') {
                        session.write(payload)
                    }
                } finally {
                    subscription.unsubscribe()
                }
            })
            // Avoid leaking subscription if the session never comes up.
            window.setTimeout(() => subscription.unsubscribe(), 5000)
            return
        }

        window.dispatchEvent(new CustomEvent('tlink-send-to-terminal', { detail: { text } }))
    }
}
