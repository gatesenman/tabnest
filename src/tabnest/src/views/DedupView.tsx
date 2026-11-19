import { useEffect, useState } from 'react'
import type { NearDupGroupUI } from '../api'
import { call } from '../api'
import { useApp } from '../ctx'

/**
 * Duplicates and near-duplicates: same link; link differing only by tracking params / mobile host / trailing slash;
 * or same site + same title. Merging keeps one item (radio) and moves the rest to the recycle bin — undoable in 智能整理.
 */
export default function DedupView() {
  const app = useApp()
  const [groups, setGroups] = useState<NearDupGroupUI[] | null>(null)
  const [keep, setKeep] = useState<Record<string, string>>({})
  useEffect(() => {
    void call('dedup:near')
      .then(setGroups)
      .catch((e: Error) => app.toast(e.message))
  }, [app.snap, app])
  if (!groups) return <p className="muted">正在查找重复链接…</p>
  const merge = async (g: NearDupGroupUI) => {
    const k = keep[g.key]
    if (k && k !== g.keepId) await call('dedup:merge', { keepId: k, removeIds: g.items.map((t) => t.id) })
    else await call('dedup:mergeNear', { keys: [g.key] })
  }
  const location = (t: NearDupGroupUI['items'][number]) => (t.collectionId ? (app.collectionsById.get(t.collectionId)?.name ?? '') : '未整理')
  return (
    <div className="view">
      <div className="view-head">
        <span className="muted">
          {groups.length} 组 · 识别 utm/spm 跟踪参数、m./www.
          移动版、末尾斜杠、#锚点，以及同站点同标题。合并后保留一条（选中的单选项），其余进回收站，可在「智能整理」撤销。
        </span>
        {groups.length > 0 && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() =>
              void app.run(
                () => call('dedup:mergeNear', {}),
                (r) => `已合并 ${r.groups} 组（可撤销）`
              )
            }
          >
            全部合并
          </button>
        )}
      </div>
      <div className="list-scroll">
        {groups.length === 0 && <p className="muted pad">没有重复链接。</p>}
        {groups.map((g) => {
          const k = keep[g.key] ?? g.keepId
          return (
            <div key={g.key + g.keepId} className="group dup-group">
              <div className="group-header">
                <span className="group-title">{g.reason}</span>
                <span className="count">{g.items.length}</span>
                <button className="btn btn-primary btn-sm" onClick={() => void app.run(() => merge(g), '已合并（可撤销）')}>
                  合并
                </button>
              </div>
              {g.items.map((t) => (
                <label key={t.id} className="tab-row">
                  <input type="radio" name={g.key} checked={k === t.id} onChange={() => setKeep({ ...keep, [g.key]: t.id })} />
                  <span className="tab-info">
                    <span className="title">
                      {t.title}
                      {k === t.id && <span className="chip">保留</span>}
                    </span>
                    <span className="url">
                      {t.url} · {location(t)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
