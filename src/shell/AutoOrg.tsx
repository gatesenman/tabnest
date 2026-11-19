import { useCallback, useEffect, useState } from 'react'
import { Bot, Cpu, Cloud, RotateCcw, Play, Trash2, Check, X, CopyCheck } from 'lucide-react'
import { call, onEvent, type NearDupGroupUI, type OrgStatus, type UsageUI } from '../api'
import { localDay } from './Panes'

const KIND: Record<string, string> = {
  classify: '自动归类',
  accept: '接受建议',
  create: '新建收藏夹',
  merge: '合并',
  rename: '重命名',
  nest: '细分',
  dedupe: '合并重复'
}
const when = (iso: string) => {
  const d = new Date(iso)
  const t = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return localDay(d) === localDay() ? `今天 ${t}` : `${d.getMonth() + 1}/${d.getDate()} ${t}`
}

export function AutoOrgPane({
  run,
  onSettings
}: {
  run: <T>(fn: () => Promise<T>, ok?: string | ((r: T) => string)) => Promise<T | undefined>
  onSettings: () => void
}) {
  const [st, setSt] = useState<OrgStatus | null>(null)
  const [tab, setTab] = useState<'pending' | 'log' | 'rules' | 'dup'>('log')
  const [dups, setDups] = useState<NearDupGroupUI[] | null>(null)
  const [usage, setUsage] = useState<UsageUI | null>(null)
  const [what, setWhat] = useState<'all' | 'tab' | 'bookmark'>('all')
  const load = useCallback(() => {
    void call('org:status')
      .then(setSt)
      .catch(() => undefined)
    void call('ai:usage')
      .then(setUsage)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    if (tab === 'dup')
      void call('dedup:near')
        .then(setDups)
        .catch(() => undefined)
  }, [tab, st])
  useEffect(() => {
    load()
    const off = onEvent('data:changed', () => setTimeout(load, 300))
    return off
  }, [load])
  if (!st) return <div className="pad muted">加载中…</div>
  const logRows = st.log.filter((e) => what === 'all' || (e.target ?? 'tab') === what || e.target === 'mixed')
  const pendRows = st.pending.filter((p) => what === 'all' || (p.kind ?? 'tab') === what)
  const today = st.log.filter((e) => !e.undone && localDay(new Date(e.at)) === localDay())
  return (
    <div className="autoorg" data-testid="autoorg">
      <div className="ao-head">
        <Bot size={20} />
        <div className="ao-state">
          <b>
            自动整理：
            <span className={st.enabled ? 'st-ok' : 'st-none'}>{st.enabled ? '已开启' : '已关闭'}</span>
          </b>
          <span className="muted small">
            {st.engine === 'cloud' ? (
              <>
                <Cloud size={12} /> 云端 AI（{st.model}）+ 本地规则
              </>
            ) : (
              <>
                <Cpu size={12} /> 本地引擎（离线 · 站点库 {st.siteCount} 个 · 关键词/TF-IDF 聚类 · {st.rules.length} 条学习规则）
              </>
            )}
            {' · '}置信度 ≥ {Math.round(st.threshold * 100)}% 自动归类{st.lastRunAt ? ` · 上次运行 ${when(st.lastRunAt)}` : ''}
            {st.undescribed ? ` · 后台补全描述剩 ${st.undescribed} 个` : ''}
          </span>
          <span className="muted small">
            {st.enrichment ? `AI 元信息 ${st.enrichment.enriched}/${st.enrichment.total} · 网页正文已读取 ${st.enrichment.fetched ?? 0}` : ''}
            {st.cloudEnabled && usage
              ? ` · 今日云端用量 ${usage.tokens.toLocaleString()}${usage.cap ? ` / ${usage.cap.toLocaleString()}` : ''} tokens（${usage.requests} 次请求，缓存命中 ${usage.cacheHits}）${usage.costUsd !== null ? ` · 约 $${usage.costUsd}` : ''}`
              : ''}
          </span>
          {st.lastError && <span className="st-warn small">{st.lastError}</span>}
        </div>
        <span className="sb-fill" />
        <button
          className="btn btn-sm btn-primary"
          onClick={() =>
            void run(
              () => call('org:run', { review: true }),
              (r) => `已归类 ${r.moved} 个，调整收藏夹 ${r.ops} 处，待确认 ${r.pending} 个`
            ).then(load)
          }
        >
          <Play size={13} /> 立即整理
        </button>
        <button
          className="btn btn-sm"
          disabled={!today.length}
          onClick={() =>
            confirm(`撤销今天全部 ${today.length} 项自动整理？`) &&
            void run(
              () => call('org:undoToday'),
              (n) => `已撤销 ${n} 项`
            ).then(load)
          }
        >
          <RotateCcw size={13} /> 撤销今天全部
        </button>
        <button className="btn btn-sm" onClick={onSettings}>
          设置…
        </button>
      </div>
      <div className="tabs-row" role="tablist">
        {(
          [
            ['log', `自动整理记录（${st.log.length}）`],
            ['pending', `待确认建议（${st.pending.length}）`],
            ['rules', `学习到的规则（${st.rules.length}）`],
            ['dup', `重复项（${st.duplicates ?? 0}）`]
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tabbtn ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
        {(tab === 'log' || tab === 'pending') && (
          <span className="ao-filter" data-testid="org-filter" style={{ marginLeft: 'auto' }}>
            {(
              [
                ['all', '全部'],
                ['tab', '标签'],
                ['bookmark', '收藏']
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={`tabbtn ${what === k ? 'on' : ''}`} aria-pressed={what === k} onClick={() => setWhat(k)}>
                {l}
              </button>
            ))}
          </span>
        )}
      </div>
      {tab === 'log' && (
        <table className="kv">
          <thead>
            <tr>
              <th style={{ width: 110 }}>时间</th>
              <th style={{ width: 80 }}>类型</th>
              <th>变更</th>
              <th style={{ width: 60 }}>引擎</th>
              <th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {logRows.map((e) => (
              <tr key={e.id} className={e.undone ? 'undone' : ''} data-testid="org-log">
                <td>{when(e.at)}</td>
                <td>
                  {KIND[e.kind] ?? e.kind}
                  {e.target === 'bookmark' || e.target === 'mixed' ? <span className="badge"> 收藏</span> : null}
                </td>
                <td>
                  {e.summary}
                  {e.why && e.why.length > 0 && (
                    <details>
                      <summary className="muted small">依据</summary>
                      <ul className="why-list">
                        {e.why.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </td>
                <td>{e.engine === 'cloud' ? '云端' : '本地'}</td>
                <td className="act">
                  {e.undone ? (
                    <span className="muted">已撤销</span>
                  ) : (
                    <button className="link" onClick={() => void run(() => call('org:undo', { id: e.id }), '已撤销').then(load)}>
                      撤销
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!logRows.length && (
              <tr>
                <td colSpan={5} className="muted">
                  还没有自动整理记录。每次快照后会自动归类新标签，每晚复查一次收藏夹结构。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      {tab === 'pending' && (
        <>
          <p className="muted small pad">这里只列出「未整理」中 AI 能给出去向的标签；没有把握的仍留在「未整理」，所以两边数字不同。</p>
          {pendRows.length > 0 && (
            <div className="pad">
              <button
                className="btn btn-sm btn-primary"
                onClick={() =>
                  void run(
                    () => call('org:accept', { tabIds: pendRows.map((p) => p.tabId) }),
                    (n) => `已接受 ${n} 条`
                  ).then(load)
                }
              >
                <Check size={13} /> 全部接受
              </button>
            </div>
          )}
          <table className="kv">
            <thead>
              <tr>
                <th>标签</th>
                <th>建议收藏夹</th>
                <th className="num">置信度</th>
                <th>依据</th>
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {pendRows.map((p) => (
                <tr key={p.tabId}>
                  <td title={p.domain}>
                    {p.kind === 'bookmark' ? <span className="badge">收藏 </span> : null}
                    {p.title}
                  </td>
                  <td>{p.target}</td>
                  <td className="num">{Math.round(p.confidence * 100)}%</td>
                  <td className="muted">{p.reason}</td>
                  <td className="act">
                    <button className="link" title="接受" onClick={() => void run(() => call('org:accept', { tabIds: [p.tabId] })).then(load)}>
                      <Check size={13} />
                    </button>
                    <button className="link" title="忽略" onClick={() => void call('org:dismiss', { tabIds: [p.tabId] }).then(load)}>
                      <X size={13} />
                    </button>
                  </td>
                </tr>
              ))}
              {!pendRows.length && (
                <tr>
                  <td colSpan={5} className="muted">
                    没有待确认的建议。置信度不足的标签（以及从浏览器导入、AI 想换文件夹的已收藏网址）会出现在这里。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
      {tab === 'dup' && (
        <>
          <div className="pad">
            <span className="muted small">
              识别规则：链接相同；或仅差 utm/spm 等跟踪参数、m./www. 移动版、末尾斜杠、index.html；或同站点标题完全相同。每组保留已整理 / 有备注 /
              信息最全的一条，其余移入回收站，可在「自动整理记录」里撤销。
            </span>
            {dups && dups.length > 0 && (
              <button
                className="btn btn-sm btn-primary"
                style={{ marginLeft: 8 }}
                data-testid="dedupe-all"
                onClick={() =>
                  void run(
                    () => call('dedup:mergeNear', {}),
                    (r) => `已合并 ${r.groups} 组，移除 ${r.removed} 项（可撤销）`
                  ).then(load)
                }
              >
                <CopyCheck size={13} /> 一键合并全部
              </button>
            )}
          </div>
          <table className="kv">
            <thead>
              <tr>
                <th>保留</th>
                <th className="num">重复</th>
                <th>原因</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {(dups ?? []).slice(0, 300).map((g) => {
                const keep = g.items.find((x) => x.id === g.keepId) ?? g.items[0]
                return (
                  <tr key={g.key + g.keepId}>
                    <td title={g.items.map((x) => x.url).join('\n')}>{keep.title || keep.url}</td>
                    <td className="num">{g.items.length - 1}</td>
                    <td className="muted">{g.reason}</td>
                    <td className="act">
                      <button className="link" onClick={() => void run(() => call('dedup:mergeNear', { keys: [g.key] }), '已合并（可撤销）').then(load)}>
                        合并
                      </button>
                    </td>
                  </tr>
                )
              })}
              {dups && !dups.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    没有重复或近似重复的网址。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
      {tab === 'rules' && (
        <table className="kv">
          <thead>
            <tr>
              <th>类型</th>
              <th>匹配</th>
              <th>→ 收藏夹</th>
              <th className="num">命中</th>
              <th style={{ width: 50 }} />
            </tr>
          </thead>
          <tbody>
            {st.rules.map((r) => (
              <tr key={r.id}>
                <td>{r.kind === 'domain' ? '网站' : '关键词'}</td>
                <td>{r.match}</td>
                <td>{r.folderName}</td>
                <td className="num">{r.hits}</td>
                <td className="act">
                  <button className="link" title="删除规则" onClick={() => void call('org:deleteRule', { id: r.id }).then(load)}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
            {!st.rules.length && (
              <tr>
                <td colSpan={5} className="muted">
                  把标签从一个收藏夹拖/移到另一个，TabNest 就会记住：以后同网站、同关键词的标签自动放到那里。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
