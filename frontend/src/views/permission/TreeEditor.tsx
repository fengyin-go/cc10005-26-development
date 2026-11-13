/** 域名路径树编辑器：允许区 / 排除区 / 例外授权三态，支持并行编辑后的冲突解决。 */
import { useEffect, useRef, useState } from 'react'

import type { ConflictDetail, DomainDetail, TreeNode, Zone } from './types'

const ZONES: { key: Zone; label: string; className: string }[] = [
  { key: 'allow', label: '允许区', className: 'zone-allow' },
  { key: 'deny', label: '排除区', className: 'zone-deny' },
  { key: 'exception', label: '例外授权', className: 'zone-exception' },
]

let nodeSeq = 0
function nextNodeId(): string {
  nodeSeq += 1
  return `edit-${Date.now()}-${nodeSeq}`
}

function cloneTree(node: TreeNode): TreeNode {
  return { ...node, children: node.children.map(cloneTree) }
}

function updateNode(node: TreeNode, targetId: string, patch: Partial<TreeNode>): TreeNode {
  if (node.id === targetId) {
    return { ...node, ...patch }
  }
  return { ...node, children: node.children.map((child) => updateNode(child, targetId, patch)) }
}

function removeNode(node: TreeNode, targetId: string): TreeNode {
  return {
    ...node,
    children: node.children
      .filter((child) => child.id !== targetId)
      .map((child) => removeNode(child, targetId)),
  }
}

function addChild(node: TreeNode, parentId: string, child: TreeNode): TreeNode {
  if (node.id === parentId) {
    return { ...node, children: [...node.children, child] }
  }
  return { ...node, children: node.children.map((c) => addChild(c, parentId, child)) }
}

interface Props {
  domain: DomainDetail
  readOnly: boolean
  conflict: ConflictDetail | null
  onSave: (tree: TreeNode, aliases: string[]) => void
  onResolveConflict: (serverTree: TreeNode) => void
  onDiscardConflict: () => void
}

export default function TreeEditor({
  domain, readOnly, conflict, onSave, onResolveConflict, onDiscardConflict,
}: Props) {
  const [draft, setDraft] = useState<TreeNode>(() => cloneTree(domain.tree))
  const [aliasesDraft, setAliasesDraft] = useState<string>(domain.aliases.join(', '))
  const [dirty, setDirty] = useState(false)
  const baseVersion = useRef(domain.version)

  // 切换域名或服务端版本推进后，以最新树为新的编辑基线
  useEffect(() => {
    setDraft(cloneTree(domain.tree))
    setAliasesDraft(domain.aliases.join(', '))
    setDirty(false)
    baseVersion.current = domain.version
  }, [domain.id, domain.version])

  const withdrawn = domain.status === '已撤回'
  const locked = readOnly || withdrawn

  function mutate(next: TreeNode) {
    setDraft(next)
    setDirty(true)
  }

  function handleAddChild(parentId: string) {
    const path = window.prompt('新节点路径（必须以 / 开头，例如 /news/2026）')
    if (!path) return
    const trimmed = path.trim()
    if (!trimmed.startsWith('/')) {
      window.alert('路径必须以 / 开头')
      return
    }
    const name = trimmed.split('/').filter(Boolean).pop() || trimmed
    mutate(addChild(draft, parentId, {
      id: nextNodeId(), name, path: trimmed, zone: 'allow', children: [],
    }))
  }

  function handleSave() {
    const aliases = aliasesDraft
      .split(/[,，\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
    onSave(draft, aliases)
  }

  return (
    <div className="tree-editor card-block">
      <div className="block-head">
        <div>
          <h3>路径树（编辑基线 v{baseVersion.current} → 当前服务端 v{domain.version}）</h3>
          <p className="hint">排除路径压过允许路径；例外节点还需在「限时例外」里拿到独立审批并在有效期内才放行。</p>
        </div>
        {!locked && (
          <div className="block-actions">
            <button className="btn" type="button" disabled={!dirty}
              onClick={() => { setDraft(cloneTree(domain.tree)); setDirty(false) }}>
              放弃修改
            </button>
            <button className="btn primary" type="button" disabled={!dirty} onClick={handleSave}>
              保存路径树
            </button>
          </div>
        )}
      </div>

      {withdrawn && (
        <div className="notice danger">许可已撤回（撤回版本 v{domain.withdraw_version}），路径树只读，历史授权不再放行任何请求。</div>
      )}
      {readOnly && !withdrawn && (
        <div className="notice">当前角色为只读，可查看共享许可与路径树，但不能改动。</div>
      )}
      {conflict && (
        <div className="notice conflict">
          <strong>保存冲突：</strong>
          你基于 v{conflict.base_version} 的修改已过期，{conflict.latest_updated_by} 已在
          {conflict.latest_updated_at.slice(0, 19).replace('T', ' ')} 保存了 v{conflict.latest_version}。
          不能覆盖他人授权，请先拉取服务端版本，再把你的改动重新合并后保存。
          <div className="conflict-actions">
            <button className="btn primary" type="button" onClick={() => onResolveConflict(conflict.server_tree)}>
              拉取服务端版本并重新合并
            </button>
            <button className="btn ghost" type="button" onClick={onDiscardConflict}>暂不处理</button>
          </div>
        </div>
      )}

      <div className="alias-row">
        <span>域名别名（逗号分隔，别名地址会回归属域名重新匹配）</span>
        <input
          value={aliasesDraft}
          disabled={locked}
          placeholder="例如 m.news.example.com, news-example.cn"
          onChange={(event) => { setAliasesDraft(event.target.value); setDirty(true) }}
        />
      </div>

      <ul className="tree-root">
        <TreeRow
          node={draft} depth={0} locked={locked} isRoot
          onZone={(id, zone) => mutate(updateNode(draft, id, { zone }))}
          onRename={(id, name) => mutate(updateNode(draft, id, { name }))}
          onPath={(id, path) => mutate(updateNode(draft, id, { path }))}
          onAdd={handleAddChild}
          onRemove={(id) => mutate(removeNode(draft, id))}
        />
      </ul>
    </div>
  )
}

interface RowProps {
  node: TreeNode
  depth: number
  locked: boolean
  isRoot?: boolean
  onZone: (id: string, zone: Zone) => void
  onRename: (id: string, name: string) => void
  onPath: (id: string, path: string) => void
  onAdd: (parentId: string) => void
  onRemove: (id: string) => void
}

function TreeRow({ node, depth, locked, isRoot, onZone, onRename, onPath, onAdd, onRemove }: RowProps) {
  return (
    <li className="tree-row-wrap">
      <div className={`tree-row zone-${node.zone}`} style={{ marginLeft: depth * 22 }}>
        <span className="tree-node-name">
          <input
            className="tree-name-input"
            value={node.name}
            disabled={locked}
            onChange={(event) => onRename(node.id, event.target.value)}
          />
        </span>
        <input
          className="tree-path-input"
          value={node.path}
          disabled={locked}
          onChange={(event) => onPath(node.id, event.target.value)}
        />
        <span className="zone-switch">
          {ZONES.map((zone) => (
            <button
              key={zone.key}
              type="button"
              disabled={locked}
              className={`zone-chip ${zone.className} ${node.zone === zone.key ? 'active' : ''}`}
              onClick={() => onZone(node.id, zone.key)}
            >
              {zone.label}
            </button>
          ))}
        </span>
        {!locked && (
          <span className="tree-tools">
            <button className="link" type="button" onClick={() => onAdd(node.id)}>加子节点</button>
            {!isRoot && <button className="link danger-link" type="button" onClick={() => onRemove(node.id)}>删除</button>}
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="tree-children">
          {node.children.map((child) => (
            <TreeRow
              key={child.id} node={child} depth={depth + 1} locked={locked}
              onZone={onZone} onRename={onRename} onPath={onPath} onAdd={onAdd} onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
