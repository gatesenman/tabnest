import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarRange, Clock, Power, RefreshCw, Zap } from 'lucide-react'
import type { Snapshot } from '../../shared/types'
import type { Reconciliation, FixAction } from '../../shared/reconcile'
import type { LifecycleIndex } from '../../shared/lifecycle'
import { call, type BrowserCardUI, type DigestUI } from '../api'
import { Modal } from '../components/Modals'
import { localDay } from './Panes'

const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—')
const md = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${hm(iso)}`
}

export function OverviewHome({
  snap,
  lc,
  recon,
  autoLabel,
  onGo,
  onTriage
}: {
  snap: Snapshot
  lc: LifecycleIndex
  recon: Reconciliation[] | null
  autoLabel: string
  onGo: (node: string) => void
  onTriage: () => void
}) {
  const m = useMemo(() => {
    const today = localDay()
    const daily = snap.sessions.filter((s) => s.kind === 'daily' && s.day)
    const t = daily.find((s) => s.day === today)
    return {
      todayCount: t?.itemCount ?? 0,
      added: t?.addedCount ?? 0,
      closed: lc.latestDay === today ? lc.disappeared.length : 0,
      pending: snap.tabs.filter((x) => !x.collectionId).length
    }
  }, [snap, lc])
  const tiles: [string, number | string, string?][] = [
    ['今日标签', m.todayCount, 'daily'],
    ['今日新增', m.added, 'daily'],
    ['今日关闭', m.closed, 'gone'],
    ['待整理', m.pending, 'unsorted']
  ]
  return (
    <div className="home" data-testid="overview">
      <div className="tiles">
        {tiles.map(([k, v, go]) => (
          <button key={k} className="tile" onClick={() => go && onGo(go)}>
            <span className="tile-v">{typeof v === 'number' ? v.toLocaleString() : v}</span>
            <span className="tile-k">{k}</span>
          </button>
        ))}
      </div>
      <div className="home-cols">
        <section className="group">
          <h3>今日</h3>
          <button className="btn btn-sm btn-primary" onClick={onTriage} disabled={!m.pending}>
            <Zap size={13} /> 快速整理未整理
          </button>
          <p className="muted small">{autoLabel}</p>
        </section>
        <section className="group">
          <h3>
            各浏览器状态
            <button className="link" onClick={() => onGo('reconcile')}>
              数量对账 →
            </button>
          </h3>
          <table className="kv compact">
            <tbody>
              {(recon ?? []).map((r) => (
                <tr key={r.browserId}>
                  <td>{r.name}</td>
                  <td className="num">{r.best}</td>
                  <td>
                    <Fresh r={r} />
                  </td>
                </tr>
              ))}
              {recon && !recon.length && (
                <tr>
                  <td className="muted">未检测到浏览器</td>
                </tr>
              )}
              {!recon && (
                <tr>
                  <td className="muted">正在读取…</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <WeeklyDigest snap={snap} onGo={onGo} />
      </div>
    </div>
  )
}

/** 本周 AI 摘要: what was collected, main topics / sites, and stale items worth a look. Compact, no scores. */
function WeeklyDigest({ snap, onGo }: { snap: Snapshot; onGo: (node: string) => void }) {
  const [d, setD] = useState<DigestUI | null>(null)
  useEffect(() => {
    const t = setTimeout(
      () =>
        void call('ai:digest')
          .then(setD)
          .catch(() => undefined),
      300
    )
    return () => clearTimeout(t)
  }, [snap])
  if (!d) return null
  const readLater = snap.collections.find((c) => c.builtin && c.name === '稍后阅读')
  const go: Record<DigestUI['stale'][number]['kind'], string> = {
    readLater: readLater ? `col:${readLater.id}` : 'collections',
    unsorted: 'unsorted',
    dead: 'unsorted',
    dup: 'autoorg'
  }
  const diff = d.added - d.addedPrev
  return (
    <section className="group" data-testid="weekly-digest">
      <h3>
        <CalendarRange size={14} /> 本周 AI 摘要
      </h3>
      <div className="digest">
        <div>
          <p className="small">
            新收集 <b>{d.added}</b> 项
            {d.addedPrev ? (
              <span className="muted">
                （上周 {d.addedPrev}，{diff >= 0 ? `+${diff}` : diff}）
              </span>
            ) : null}{' '}
            · AI 自动归类 {d.organized} 项
          </p>
          {d.topTopics.length > 0 && (
            <div className="chips" title="本周新增内容的主要主题">
              {d.topTopics.map((t) => (
                <span key={t.name} className="chip">
                  {t.name} {t.count}
                </span>
              ))}
            </div>
          )}
          {d.topSites.length > 0 && <p className="muted small">常去：{d.topSites.map((x) => `${x.name} ${x.count}`).join(' · ')}</p>}
        </div>
        <div className="digest-stale">
          {d.stale.length ? (
            d.stale.map((x) => (
              <p key={x.kind} className="small">
                {x.kind === 'dup' ? `${x.count} ${x.label}` : `${x.label} ${x.count} 项`}
                <button className="link" onClick={() => onGo(go[x.kind])}>
                  查看 →
                </button>
              </p>
            ))
          ) : (
            <p className="muted small">没有需要清理的陈旧项目。</p>
          )}
        </div>
      </div>
    </section>
  )
}

function Fresh({ r }: { r: Reconciliation }) {
  if (r.freshness === 'none') return <span className="pill">无标签</span>
  return (
    <span className={`pill ${r.freshness === 'fresh' ? '' : 'warn'}`} title={r.locked ? '会话文件被锁定，显示的是存档' : ''}>
      {r.locked ? <AlertTriangle size={11} /> : <Clock size={11} />} 存档 {r.archiveAt ? hm(r.archiveAt) : ''}
      {r.locked ? ' · 已锁定' : ''}
    </span>
  )
}

const FIX_LABEL: Record<FixAction, string> = { closeThis: '只快照并关闭此浏览器', snapshotNow: '立即快照' }

export function ReconcilePane({
  recon,
  loading,
  onRefresh,
  onFix
}: {
  recon: Reconciliation[] | null
  loading: boolean
  onRefresh: () => void
  onFix: (a: FixAction, r: Reconciliation) => void
}) {
  return (
    <div className="recon" data-testid="reconcile">
      <div className="recon-head">
        <span>每个数字从哪里来、为什么和浏览器里看到的不一样：</span>
        <button className="btn btn-sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={13} /> {loading ? '读取中…' : '重新读取'}
        </button>
      </div>
      <p className="muted small pad">
        数据来自浏览器会话文件。Edge / Vivaldi / QQ 等运行时会锁定当前会话：对账显示较旧存档；要最新数字请用「只快照并关闭此浏览器」。
      </p>
      {recon && !recon.length && <p className="muted pad">未检测到已安装的浏览器。</p>}
      {(recon ?? []).map((r) => (
        <section key={r.browserId} className={`rcard ${r.fixes.some((f) => f !== 'snapshotNow') ? 'rcard-warn' : ''}`}>
          <header>
            <b>{r.name}</b>
            <Fresh r={r} />
            {r.running ? <span className="muted small">运行中</span> : <span className="muted small">未运行</span>}
          </header>
          <table className="rnums">
            <thead>
              <tr>
                <th>存档读取</th>
                <th>已过滤</th>
                <th>去重后</th>
                <th>今日快照中</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  {r.rawTabs}
                  {r.archiveAt && <span className="muted small"> @ {md(r.archiveAt)}</span>}
                </td>
                <td>{r.filtered}</td>
                <td>{r.deduped}</td>
                <td>{r.inToday}</td>
              </tr>
            </tbody>
          </table>
          <div className="why">
            <b>为什么不一样</b>
            <ul>
              {r.reasons.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
          {r.fixes.length > 0 && (
            <div className="fixes">
              {r.fixes.map((f) => (
                <button key={f} className={`btn btn-sm ${f === 'closeThis' ? 'btn-primary' : ''}`} onClick={() => onFix(f, r)}>
                  {f === 'closeThis' ? <Power size={13} /> : <RefreshCw size={13} />} {FIX_LABEL[f]}
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

export function WelcomeDialog({
  leftover,
  browsers,
  onStart,
  onClear,
  onLater
}: {
  leftover: number
  browsers: BrowserCardUI[]
  onStart: () => void
  onClear: () => void
  onLater: () => void
}) {
  const found = browsers.filter((b) => b.installed)
  return (
    <Modal
      title="欢迎使用 TabNest 页签巢"
      width={520}
      onClose={onLater}
      footer={
        <>
          {leftover > 0 && (
            <button className="btn" onClick={onClear}>
              清空旧数据并开始
            </button>
          )}
          <button className="btn btn-primary" onClick={onStart}>
            开始使用
          </button>
          <button className="btn" onClick={onLater}>
            稍后
          </button>
        </>
      }
    >
      <div className="welcome" data-testid="welcome">
        <p>TabNest 每天自动给所有浏览器的标签拍一份快照，你可以放心关掉浏览器，随时找回。无需安装浏览器扩展。</p>
        <ul>
          <li>检测到 {found.length ? found.map((b) => b.name).join('、') : '0 个浏览器'}</li>
          <li>自动快照：每 30 分钟 + 休眠 / 关机 / 锁屏时（可在 设置 › 常规 修改）</li>
          <li>Edge / Vivaldi / QQ 运行中锁定会话时，用「只快照并关闭此浏览器」获取最新标签</li>
        </ul>
        {leftover > 0 && (
          <p className="warnbox">
            <AlertTriangle size={14} /> 检测到 {leftover} 个旧数据（可能来自旧版本或示例）。如果它们不是你的，点「清空旧数据并开始」。
          </p>
        )}
      </div>
    </Modal>
  )
}
