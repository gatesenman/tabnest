import { useEffect, useState } from 'react'
import { call, type CloseOutcome, type ClosePreview } from '../api'
import { Modal } from './Modals'

type Phase = 'scanning' | 'confirm' | 'working' | 'result' | 'error'

/**
 * 一键「快照并关闭浏览器」：
 * 1) 扫描正在运行的浏览器与标签数 → 2) 用户确认 → 3) 主进程先快照、校验、再逐个优雅关闭。
 * 主进程会拒绝关闭「快照读到 0 个标签却仍在运行」的浏览器，除非用户在这里勾选强制。
 */
export default function CloseBrowsersModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string, sessionId: string) => void }) {
  const [phase, setPhase] = useState<Phase>('scanning')
  const [preview, setPreview] = useState<ClosePreview | null>(null)
  const [force, setForce] = useState(false)
  const [shutdown, setShutdown] = useState(false)
  const [shutdownAllowed, setShutdownAllowed] = useState(false)
  const [outcome, setOutcome] = useState<CloseOutcome | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const [p, s] = await Promise.all([call('capture:closePreview'), call('settings:get')])
        setPreview(p)
        setShutdownAllowed(!!s.shutdownAfterClose)
        setShutdown(false)
        setPhase('confirm')
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        setPhase('error')
      }
    })()
  }, [])

  const empties = preview?.browsers.filter((b) => b.running && b.tabs === 0) ?? []

  const go = async () => {
    if (shutdown && !confirm('最后确认：保存并关闭浏览器后将关闭这台电脑。确定吗？')) return
    setPhase('working')
    try {
      const r = await call('capture:closeAndSnapshot', { forceEvenIfEmpty: force, alsoShutdown: shutdown })
      setOutcome(r)
      setPhase('result')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }

  const closedCount = outcome?.closed.filter((c) => c.closed).length ?? 0
  const notClosed = outcome?.closed.filter((c) => !c.closed) ?? []
  const forceRetry = async () => {
    // Retry only those still running, with the user's explicit consent to force.
    setPhase('working')
    try {
      const r = await call('capture:closeAndSnapshot', { forceEvenIfEmpty: true, alsoShutdown: false })
      setOutcome(r)
      setPhase('result')
    } catch (e) {
      setErr(String(e))
      setPhase('error')
    }
  }

  return (
    <Modal title="快照并关闭所有浏览器" width={620} onClose={phase === 'working' ? () => undefined : onClose}>
      {phase === 'scanning' && <p>正在读取各浏览器当前打开的标签…</p>}
      {phase === 'error' && (
        <>
          <p className="danger">出错了：{err}</p>
          <p className="muted">没有关闭任何浏览器。</p>
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              好
            </button>
          </div>
        </>
      )}
      {phase === 'confirm' && preview && (
        <>
          {preview.browsers.length === 0 ? (
            <p>没有检测到正在运行的浏览器。仍会把当前会话文件里的标签并入今日快照。</p>
          ) : (
            <table className="close-table">
              <thead>
                <tr>
                  <th>浏览器</th>
                  <th>进程</th>
                  <th>标签数</th>
                  <th>顺序</th>
                </tr>
              </thead>
              <tbody>
                {preview.browsers.map((b) => (
                  <tr key={b.id}>
                    <td>{b.name}</td>
                    <td className="mono">{b.process}</td>
                    <td>{b.tabs}</td>
                    <td>
                      {b.strategy === 'close-then-read' ? (
                        <span className="warn">
                          ① 先正常关闭 → ② 读取刚写入的会话 → ③ 保存
                          {b.staleAt && (
                            <small className="muted">
                              {' '}
                              （当前只能看到 {new Date(b.staleAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 的快照）
                            </small>
                          )}
                        </span>
                      ) : b.tabs > 0 ? (
                        <span className="ok">✓ 保存 → 关闭</span>
                      ) : (
                        <span className="warn">⚠ 未读到标签，默认不关闭</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted">{preview.note}</p>
          <p>
            将先把 <b>{preview.totalTabs}</b> 个标签并入<b>今日快照</b>（自动去重），确认保存成功后再逐个正常关闭浏览器（不会强杀，浏览器会保存自己的会话；10
            秒内未退出会强制结束）。
          </p>
          {empties.length > 0 && (
            <label className="row">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 我确认：{empties.map((b) => b.name).join('、')}{' '}
              里没有需要保存的标签，也一起关闭
            </label>
          )}
          {shutdownAllowed && (
            <label className="row warn">
              <input type="checkbox" checked={shutdown} onChange={(e) => setShutdown(e.target.checked)} /> 完成后关闭电脑
            </label>
          )}
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn btn-primary" onClick={() => void go()}>
              保存并关闭{shutdown ? '，然后关机' : ''}
            </button>
          </div>
        </>
      )}
      {phase === 'working' && <p>正在快照并关闭浏览器，请稍候（最多约 10 秒/个）…</p>}
      {phase === 'result' && outcome && (
        <>
          <p className="result-big">
            已保存 {outcome.capture.total} 个标签并关闭 {closedCount} 个浏览器
          </p>
          <p className="muted">
            今日快照共 {outcome.capture.dayTotal} 个 · 本次新增 {outcome.capture.newToday} · 数据来源：
            {{ session: '会话文件' }[outcome.capture.source]}
          </p>
          {outcome.unread.map((u) => (
            <p key={u.id} className="warn">
              ⚠ {u.name} 已关闭，但仍无法读取它的会话文件。别担心，标签没丢：重新打开 {u.name}，用「恢复上次会话」（Ctrl+Shift+T）即可找回。
            </p>
          ))}
          {outcome.skipped.map((s) => (
            <p key={s.id} className="warn">
              ⚠ {s.reason}
            </p>
          ))}
          {notClosed.map((c) => (
            <p key={c.id} className="warn">
              ⚠ {c.process} 未能关闭{c.error ? `：${c.error}` : ''}
            </p>
          ))}
          {outcome.shutdown && <p className="warn">电脑将在 30 秒后关机（Windows 可运行 shutdown /a 取消）。</p>}
          <div className="modal-actions">
            {notClosed.length > 0 && (
              <button className="btn btn-primary" onClick={() => void forceRetry()}>
                强制关闭剩余
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={() => onDone(`已保存 ${outcome.capture.total} 个标签并关闭 ${closedCount} 个浏览器`, outcome.capture.sessionId)}
            >
              查看今日快照
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}
