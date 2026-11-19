import { useEffect, useMemo, useState } from 'react'
import { Globe, Image as ImageIcon, Lightbulb, RefreshCw, Sparkles } from 'lucide-react'
import { canPreview, previewSrc } from '../../shared/preview'
import type { Snapshot } from '../../shared/types'
import { call, type ExplainUI, type PreviewInfoUI } from '../api'
import type { GridRow } from './DataGrid'

const STATUS_TEXT: Record<string, string> = { unchecked: '未检查', ok: '正常', redirect: '重定向', broken: '失效', timeout: '超时', checking: '检查中' }

const fmt = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false })
const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Right-hand properties pane: 「AI 摘要」 card first, then 归类依据, properties, raw description (collapsed), note. */
export function DetailsPane({
  row,
  count,
  onSummarize,
  summarizing,
  onCheckLink,
  onAiSettings
}: {
  row: GridRow | null
  count: number
  onSummarize?: () => void
  summarizing?: boolean
  onCheckLink?: () => void
  onAiSettings?: () => void
}) {
  const [note, setNote] = useState(row?.note ?? '')
  useEffect(() => setNote(row?.note ?? ''), [row?.id, row?.note])
  const [why, setWhy] = useState<ExplainUI | null>(null)
  useEffect(() => {
    setWhy(null)
    if (!row?.id) return
    let live = true
    const t = setTimeout(
      () =>
        void call('ai:explain', { id: row.id })
          .then((r) => live && setWhy(r))
          .catch(() => undefined),
      120
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [row?.id, row?.collectionId, row?.enrichedAt, row?.linkStatus, summarizing])
  const [pv, setPv] = useState<PreviewInfoUI | null>(null)
  const [pvBusy, setPvBusy] = useState(false)
  const [pvBad, setPvBad] = useState(false)
  useEffect(() => {
    setPv(null)
    setPvBad(false)
    if (!row?.url || !canPreview(row.url)) return
    let live = true
    void call('preview:info', { url: row.url })
      .then((r) => live && setPv(r))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [row?.url])
  const refreshPreview = () => {
    if (!row || pvBusy) return
    setPvBusy(true)
    void call('preview:refresh', { url: row.url })
      .then((r) => {
        setPv(r)
        setPvBad(false)
      })
      .catch(() => undefined)
      .finally(() => setPvBusy(false))
  }
  if (!row)
    return (
      <div className="details">
        <div className="details-head">属性</div>
        <p className="muted pad">{count > 1 ? `已选择 ${count} 项` : '选择一项以查看属性'}</p>
      </div>
    )
  const save = () => note !== row.note && void call('tabs:update', { id: row.id, note })
  const desc = (row.description ?? '').trim()
  const rawSummary = (row.summary ?? '').trim()
  const stale =
    !!rawSummary && !!desc && (normText(rawSummary) === normText(desc) || normText(desc).startsWith(normText(rawSummary.split('：').slice(1).join('：'))))
  const summary = stale ? '' : rawSummary
  const points = (why?.page?.points ?? []).filter((p) => normText(p) !== normText(summary))
  const engine = why?.page?.engine ?? (row.enrichedBy === 'cloud' ? '云端 AI' : row.enrichedAt ? '本地摘要' : null)
  const isLocal = !engine || engine === '本地摘要'
  const src = why?.page?.summarySrc ?? (why?.page?.fetchStatus === 'ok' ? 'page' : row.enrichedAt ? 'title' : null)
  const when = why?.page?.summarizedAt ?? row.enrichedAt
  const chips = (() => {
    const all = [...new Set([...(row.topics ?? []), ...row.keywords])].filter((k) => !/^(introducing|announcing|new|about|the|home|blog|page)$/i.test(k))
    return all.filter((k) => !all.some((o) => o !== k && o.length > k.length && o.toLowerCase().includes(k.toLowerCase()))).slice(0, 8)
  })()
  const unchecked = !row.linkStatus || row.linkStatus === 'unknown'
  return (
    <div className="details" data-testid="details">
      <div className="details-head">属性</div>
      <div className="details-body">
        <div className="d-title">
          {row.favicon ? <img className="fav" src={row.favicon} alt="" /> : <Globe size={16} />}
          <b>{row.title}</b>
        </div>

        {canPreview(row.url) && (
          <div className="d-preview" data-testid="preview">
            {pv?.status === 'ok' && !pvBad && !pvBusy ? (
              <img src={previewSrc(row.url, pv.capturedAt)} alt="网页预览" onError={() => setPvBad(true)} data-testid="preview-img" />
            ) : (
              <div className="d-preview-empty">
                <ImageIcon size={22} />
                <span>
                  {pvBusy || pv?.status === 'pending'
                    ? '正在生成预览…'
                    : pv?.status === 'failed'
                      ? `预览生成失败（${pv.error ?? '未知原因'}）`
                      : '暂无预览（后台空闲时自动生成）'}
                </span>
              </div>
            )}
            <div className="d-preview-bar">
              <span className="muted">{pv?.capturedAt && pv.status === 'ok' ? `截图于 ${fmt(pv.capturedAt)}` : ''}</span>
              <button className="btn btn-sm" onClick={refreshPreview} disabled={pvBusy} data-testid="preview-refresh">
                <RefreshCw size={12} className={pvBusy ? 'spin' : ''} /> 刷新预览
              </button>
            </div>
          </div>
        )}

        <section className={`ai-card${summarizing ? ' busy' : ''}`} data-testid="ai-summary" aria-busy={summarizing || undefined}>
          <div className="ai-card-head">
            <Sparkles size={13} />
            <b>AI 摘要</b>
            {engine && (
              <span className={`ai-badge${isLocal ? '' : ' cloud'}`} data-testid="ai-engine">
                {engine}
              </span>
            )}
            {onSummarize && (
              <button
                className="btn btn-sm ai-regen"
                data-testid="summarize-btn"
                disabled={summarizing}
                onClick={onSummarize}
                title="重新读取网页正文并生成摘要"
              >
                <RefreshCw size={12} className={summarizing ? 'spin' : ''} />
                {summarizing ? '生成中…' : row.enrichedAt ? '重新生成' : '生成摘要'}
              </button>
            )}
          </div>
          {summarizing ? (
            <div className="ai-skeleton" data-testid="ai-loading">
              <span>正在读取网页正文并生成摘要…</span>
              <i />
              <i />
              <i className="short" />
            </div>
          ) : summary ? (
            <>
              <p className="ai-summary">{summary}</p>
              {points.length > 0 && (
                <ul className="ai-points" data-testid="ai-points">
                  {points.slice(0, 5).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">
              {stale ? '摘要正在后台更新…' : row.enrichedAt ? '暂无摘要，点「重新生成」试试' : '排队中（后台自动生成），也可以点「生成摘要」'}
            </p>
          )}
          {chips.length > 0 && !summarizing && (
            <div className="chips">
              {chips.map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
            </div>
          )}
          {!summarizing && (src || when) && (
            <p className="ai-meta muted" data-testid="enrich-status">
              {src === 'page'
                ? '内容来源：网页正文'
                : src === 'title'
                  ? `内容来源：标题和网址${why?.page?.fetchStatus && why.page.fetchStatus !== 'ok' ? `（网页未读取：${why.page.fetchStatus}）` : ''}`
                  : ''}
              {when ? ` · ${fmt(when)}` : ''}
              {row.enrichStale ? ' · 标题/网址已变，待更新' : ''}
              {row.lang ? ` · 原文 ${row.lang}` : ''}
            </p>
          )}
          {why && !why.cloud.configured && !summarizing && (
            <p className="ai-hint" data-testid="ai-cloud-hint">
              配置云端 AI 可获得更好的中文总结 ·{' '}
              <button className="link" onClick={onAiSettings}>
                去配置
              </button>
            </p>
          )}
        </section>

        {why && (why.stored || why.live) && (
          <div className="d-why" data-testid="ai-why">
            <div className="d-sec">
              <Lightbulb size={12} /> AI 归类依据
            </div>
            {why.stored ? <p className="d-desc">{why.stored}</p> : null}
            {!why.stored && why.live ? (
              <p className="d-desc">
                建议「{why.live.target}」· 置信度 {Math.round(why.live.confidence * 100)}%
                <br />
                <span className="muted">依据：{why.live.basis.join('；')}</span>
              </p>
            ) : null}
          </div>
        )}

        <dl className="props">
          <dt>网址</dt>
          <dd className="sel-text">{row.url}</dd>
          <dt>域名</dt>
          <dd>{row.domain}</dd>
          <dt>收藏夹</dt>
          <dd>{row.folderLabel}</dd>
          <dt>链接状态</dt>
          <dd data-testid="link-status">
            {unchecked ? '未检查' : (STATUS_TEXT[row.linkStatus] ?? row.linkStatus)}
            {row.linkStatusCode ? ` (${row.linkStatusCode})` : ''}
            {row.lastCheckedAt ? <span className="muted"> · {fmt(row.lastCheckedAt)}</span> : null}
            {onCheckLink && (unchecked || row.linkStatus === 'broken' || row.linkStatus === 'timeout') && (
              <button className="link" style={{ marginLeft: 6 }} onClick={onCheckLink} data-testid="check-link">
                检查链接
              </button>
            )}
          </dd>
          <dt>出现次数</dt>
          <dd>{row.seenCount || 1}</dd>
          <dt>来源</dt>
          <dd>{row.sourceLabel || '—'}</dd>
          <dt>首次出现</dt>
          <dd>{fmt(row.firstSeen)}</dd>
          <dt>最后出现</dt>
          <dd>{fmt(row.lastSeen)}</dd>
        </dl>

        {desc && normText(desc) !== normText(summary) && (
          <details className="d-raw" data-testid="raw-desc">
            <summary>网页原始描述</summary>
            <p className="d-desc">{desc}</p>
          </details>
        )}

        <div className="d-sec">备注</div>
        <textarea
          className="field-input"
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={save}
          placeholder="添加备注…"
          aria-label="备注"
        />
      </div>
    </div>
  )
}

/** Compact stats table that replaces the old dashboard. */
export function OverviewPane({ snap }: { snap: Snapshot }) {
  const s = useMemo(() => {
    const daily = snap.sessions.filter((x) => x.kind === 'daily')
    const today = daily.find((x) => x.day === localDay())
    const st = (k: string) => snap.tabs.filter((t) => t.linkStatus === k).length
    return [
      ['标签总数', snap.tabs.length],
      ['未整理', snap.tabs.filter((t) => !t.collectionId).length],
      ['已整理', snap.tabs.filter((t) => t.collectionId).length],
      ['收藏夹', snap.collections.length],
      ['每日快照（天）', daily.length],
      ['今日快照标签', today?.itemCount ?? 0],
      ['今日较前一天新增', today?.addedCount ?? 0],
      ['链接正常 / 失效 / 超时', `${st('ok')} / ${st('broken')} / ${st('timeout')}`],
      ['回收站', snap.trash.length]
    ] as const
  }, [snap])
  return (
    <div className="overview" data-testid="overview">
      <table className="kv">
        <thead>
          <tr>
            <th>项目</th>
            <th>数值</th>
          </tr>
        </thead>
        <tbody>
          {s.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td className="num">{typeof v === 'number' ? v.toLocaleString() : v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted pad">提示：F5 立即快照，Ctrl+K 命令面板，右键表格行可移入收藏夹或用指定浏览器打开。</p>
    </div>
  )
}

export function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
