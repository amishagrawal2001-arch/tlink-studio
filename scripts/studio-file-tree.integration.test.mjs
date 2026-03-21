import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const toKey = p => {
  if (!p) {
    return null
  }
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function withWorkspace (fn) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tlink-studio-tree-'))
  const root = path.join(base, 'tlink-studio')
  await fsp.mkdir(root, { recursive: true })
  try {
    await fn(root)
  } finally {
    await fsp.rm(base, { recursive: true, force: true })
  }
}

async function ensureUniquePath (dir, name) {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  let candidate = path.join(dir, name)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${index}${ext}`)
    index++
  }
  return candidate
}

async function createFolderInFolder (parentFolder, preferredName = 'Folder') {
  const target = await ensureUniquePath(parentFolder, preferredName)
  await fsp.mkdir(target, { recursive: false })
  return target
}

async function createFileInFolder (parentFolder, preferredName = 'Untitled-1', content = '') {
  const target = await ensureUniquePath(parentFolder, preferredName)
  await fsp.mkdir(parentFolder, { recursive: true })
  await fsp.writeFile(target, content, 'utf8')
  return target
}

async function renamePathOnDisk (targetPath, nextName) {
  const parent = path.dirname(targetPath)
  const nextPath = path.join(parent, nextName)
  if (fs.existsSync(nextPath)) {
    throw new Error(`Path already exists: ${nextPath}`)
  }
  await fsp.rename(targetPath, nextPath)
  return nextPath
}

async function movePathToFolder (sourcePath, destinationFolder) {
  await fsp.mkdir(destinationFolder, { recursive: true })
  const destinationPath = await ensureUniquePath(destinationFolder, path.basename(sourcePath))
  await fsp.rename(sourcePath, destinationPath)
  return destinationPath
}

async function deleteSelectionOnDisk (fileTargets, folderTargets) {
  const uniqueFiles = Array.from(new Set(fileTargets.map(x => path.resolve(x))))
  const uniqueFolders = Array.from(new Set(folderTargets.map(x => path.resolve(x))))
  for (const filePath of uniqueFiles) {
    await fsp.rm(filePath, { force: true })
  }
  uniqueFolders.sort((a, b) => b.length - a.length)
  for (const folderPath of uniqueFolders) {
    await fsp.rm(folderPath, { recursive: true, force: true })
  }
}

function removeFolderFromList (folders, folderPath, folderRoot, selectedFolderPath) {
  const rootKey = toKey(folderRoot)
  const targetKey = toKey(folderPath)
  if (targetKey === rootKey) {
    return {
      folders: [...folders],
      selectedFolderPath: folderRoot,
    }
  }
  const nextFolders = folders.filter(item => toKey(item) !== targetKey)
  return {
    folders: nextFolders,
    selectedFolderPath: toKey(selectedFolderPath) === targetKey ? null : selectedFolderPath,
  }
}

function snapshotDocsForPersist (docs) {
  return docs.filter(doc => {
    if (!doc.path) {
      return true
    }
    return fs.existsSync(doc.path)
  })
}

test('folder and file operations work end-to-end on disk', async () => {
  await withWorkspace(async root => {
    const folder = await createFolderInFolder(root, 'Folder3')
    const file = await createFileInFolder(root, 'Untitled-2', 'hello')
    assert.equal(fs.existsSync(folder), true)
    assert.equal(fs.existsSync(file), true)

    const renamedFolder = await renamePathOnDisk(folder, 'Projects')
    assert.equal(fs.existsSync(folder), false)
    assert.equal(fs.existsSync(renamedFolder), true)

    const movedFile = await movePathToFolder(file, renamedFolder)
    assert.equal(fs.existsSync(file), false)
    assert.equal(fs.existsSync(movedFile), true)

    await deleteSelectionOnDisk([movedFile], [renamedFolder])
    assert.equal(fs.existsSync(movedFile), false)
    assert.equal(fs.existsSync(renamedFolder), false)
  })
})

test('multi-select delete removes all selected files and folders', async () => {
  await withWorkspace(async root => {
    const folderA = await createFolderInFolder(root, 'A')
    const folderB = await createFolderInFolder(root, 'B')
    const fileA1 = await createFileInFolder(folderA, 'Untitled-1', 'a1')
    const fileA2 = await createFileInFolder(folderA, 'Untitled-2', 'a2')
    const fileB1 = await createFileInFolder(folderB, 'Untitled-3', 'b1')

    await deleteSelectionOnDisk([fileA1, fileA2], [folderA])

    assert.equal(fs.existsSync(fileA1), false)
    assert.equal(fs.existsSync(fileA2), false)
    assert.equal(fs.existsSync(folderA), false)
    assert.equal(fs.existsSync(folderB), true)
    assert.equal(fs.existsSync(fileB1), true)
  })
})

test('protected workspace root is not removable from list', async () => {
  const root = '/tmp/tlink-studio'
  const folders = [root, '/tmp/other']

  const keepRoot = removeFolderFromList(folders, root, root, root)
  assert.deepEqual(keepRoot.folders, folders)
  assert.equal(keepRoot.selectedFolderPath, root)

  const removeOther = removeFolderFromList(folders, '/tmp/other', root, '/tmp/other')
  assert.deepEqual(removeOther.folders, [root])
  assert.equal(removeOther.selectedFolderPath, null)
})

test('restart persistence does not restore deleted files', async () => {
  await withWorkspace(async root => {
    const alive = await createFileInFolder(root, 'Untitled-1', 'alive')
    const toDelete = await createFileInFolder(root, 'Untitled-2', 'delete me')

    const docsBeforeDelete = [
      { id: '1', path: alive },
      { id: '2', path: toDelete },
    ]
    assert.equal(snapshotDocsForPersist(docsBeforeDelete).length, 2)

    await deleteSelectionOnDisk([toDelete], [])
    const persisted = snapshotDocsForPersist(docsBeforeDelete)
    assert.deepEqual(persisted.map(x => x.path), [alive])
  })
})

test('repeated new-folder actions can create siblings under same parent', async () => {
  await withWorkspace(async root => {
    const first = await createFolderInFolder(root, 'Folder')
    const second = await createFolderInFolder(root, 'Folder')

    assert.equal(path.dirname(first), root)
    assert.equal(path.dirname(second), root)
    assert.notEqual(path.basename(first), path.basename(second))
  })
})
