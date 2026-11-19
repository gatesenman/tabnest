import { useEffect, useState } from 'react'
import type { PublicSettings } from '../../shared/types'
import { call, type BrowserCardUI, type UsageUI } from '../api'
import { useApp } from '../ctx'
import { Modal } from '../components/Modals'

const TABS = ['常规', '浏览器', 'AI', '备份', '关于'] as const
export type SettingsTab = (typeof TABS)[number]

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      <div className="form-ctl">{children}</div>
    </div>
  )
}

export function SettingsDialog({ onClose, initialTab = '常规' }: { onClose: () => void; initialTab?: SettingsTab }) {
  const app = useApp()
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [s, setS] = useState<PublicSettings | null>(null)
  const [key, setKey] = useState('')
  const [usage, setUsage] = useState<UsageUI | null>(null)
  useEffect(() => {
    if (tab === 'AI')
      void call('ai:usage')
        .then(setUsage)
        .catch(() => undefined)
  }, [tab])
  const [pv, setPv] = useState<{ count: number; bytes: number; failed: number } | null>(null)
  useEffect(() => {
    if (tab === '常规')
      void call('preview:stats')
        .then(setPv)
        .catch(() => undefined)
  }, [tab])
  const [browsers, setBrowsers] = useState<BrowserCardUI[] | null>(null)
  useEffect(() => void call('settings:get').then(setS), [])
  useEffect(() => {
    if (tab === '浏览器' && !browsers) void call('browsers:scan', { force: false }).then(setBrowsers)
  }, [tab, browsers])
  const update = (patch: Parameters<typeof call<'settings:update'>>[1]) =>
    void app.run(() =>
      call('settings:update', patch).then((r) => {
        setS(r)
        window.dispatchEvent(new CustomEvent('tabnest:settings', { detail: r }))
      })
    )
  const allKeys = browsers?.flatMap((b) => b.profiles.map((p) => p.key)) ?? []
  const selected = s?.selectedProfiles.length ? new Set(s.selectedProfiles) : new Set(allKeys)

  return (
    <Modal
      title="设置"
      onClose={onClose}
      width={640}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          确定
        </button>
      }
    >
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'sel' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {!s ? (
        <p className="muted">加载中…</p>
      ) : (
        <div className="tab-page" role="tabpanel">
          {tab === '常规' && (
            <>
              <fieldset>
                <legend>外观</legend>
                <Row label="主题">
                  <select value={s.theme} onChange={(e) => update({ theme: e.target.value as PublicSettings['theme'] })}>
                    <option value="system">跟随系统</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </Row>
                <Row label="行高">
                  <select value={s.density} onChange={(e) => update({ density: e.target.value as PublicSettings['density'] })}>
                    <option value="compact">紧凑（28px）</option>
                    <option value="comfortable">舒适（36px）</option>
                  </select>
                </Row>
              </fieldset>
              <fieldset>
                <legend>启动</legend>
                <label className="check">
                  <input type="checkbox" checked={s.launchAtLogin} onChange={(e) => update({ launchAtLogin: e.target.checked })} /> 开机自动启动（最小化到托盘）
                </label>
              </fieldset>
              <fieldset>
                <legend>快照</legend>
                <Row label="自动快照间隔">
                  <input
                    type="number"
                    min={0}
                    max={1440}
                    style={{ width: 80 }}
                    value={s.autoSnapshotMinutes}
                    onChange={(e) => update({ autoSnapshotMinutes: Math.max(0, Math.min(1440, Number(e.target.value) || 0)) })}
                  />{' '}
                  分钟（0 = 关闭）
                </Row>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={s.shutdownAfterClose}
                    onChange={(e) => {
                      if (e.target.checked && !confirm('开启后，「快照并关闭浏览器」完成时会顺便关机（每次执行前还会再确认）。确定开启吗？')) return
                      update({ shutdownAfterClose: e.target.checked })
                    }}
                  />{' '}
                  「快照并关闭浏览器」后关闭计算机
                </label>
                <label className="check">
                  <input type="checkbox" checked={s.captureHistory} onChange={(e) => update({ captureHistory: e.target.checked })} /> 找回时包含最近 7
                  天浏览历史
                </label>
              </fieldset>
              <fieldset>
                <legend>链接检查</legend>
                <Row label={`并发数（${s.linkCheckConcurrency}）`}>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    value={s.linkCheckConcurrency}
                    onChange={(e) => update({ linkCheckConcurrency: Number(e.target.value) })}
                  />
                </Row>
                <Row label="超时">
                  <input
                    type="number"
                    min={1}
                    max={60}
                    style={{ width: 80 }}
                    value={s.linkCheckTimeoutMs / 1000}
                    onChange={(e) => update({ linkCheckTimeoutMs: Math.max(1, Math.min(60, Number(e.target.value) || 8)) * 1000 })}
                  />{' '}
                  秒
                </Row>
              </fieldset>
              <fieldset data-testid="preview-settings">
                <legend>网页预览图</legend>
                <label className="check">
                  <input type="checkbox" checked={s.previewAuto} onChange={(e) => update({ previewAuto: e.target.checked })} data-testid="preview-auto" />{' '}
                  后台自动生成网页预览截图（空闲时限速进行，静音、拦截弹窗与下载，使用独立会话不带你的登录状态；30 天后自动刷新）
                </label>
                <Row label="缓存">
                  <span data-testid="preview-size">
                    {pv
                      ? `已缓存 ${pv.count.toLocaleString()} 张 · ${(pv.bytes / 1048576).toFixed(1)} MB${pv.failed ? ` · ${pv.failed} 个失败（稍后重试）` : ''}`
                      : '…'}
                  </span>
                  <button
                    className="btn btn-sm"
                    style={{ marginLeft: 8 }}
                    disabled={!pv?.count && !pv?.failed}
                    data-testid="preview-clear"
                    onClick={() =>
                      void app.run(
                        () => call('preview:clear').then((n) => call('preview:stats').then((x) => (setPv(x), n))),
                        (n) => `已清空 ${n} 张预览图`
                      )
                    }
                  >
                    清空预览缓存
                  </button>
                </Row>
              </fieldset>
            </>
          )}
          {tab === '浏览器' && (
            <fieldset>
              <legend>快照读取的浏览器配置文件</legend>
              {!browsers ? (
                <p className="muted">正在扫描…</p>
              ) : (
                <table className="kv">
                  <thead>
                    <tr>
                      <th />
                      <th>浏览器</th>
                      <th>配置文件</th>
                      <th>打开的标签</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {browsers.flatMap((b) =>
                      b.profiles.map((p) => (
                        <tr key={p.key}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`${b.name} ${p.profileName}`}
                              checked={selected.has(p.key)}
                              onChange={(e) => {
                                const n = new Set(selected)
                                if (e.target.checked) n.add(p.key)
                                else n.delete(p.key)
                                update({ selectedProfiles: n.size === allKeys.length ? [] : [...n] })
                              }}
                            />
                          </td>
                          <td>{b.name}</td>
                          <td>{p.profileName}</td>
                          <td className="num">{p.openTabs}</td>
                          <td>
                            {p.locked ? (
                              <span className="st-warn">运行中（文件锁定）</span>
                            ) : p.stale ? (
                              <span className="st-warn">较旧</span>
                            ) : (
                              <span className="st-ok">正常</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
              <p className="muted small">Edge / Vivaldi / QQ 等运行中会锁定会话文件时，请在对账页使用「只快照并关闭此浏览器」获取最新标签。</p>
              <button className="btn btn-sm" onClick={() => void call('browsers:scan', { force: true }).then(setBrowsers)}>
                重新扫描
              </button>
            </fieldset>
          )}
          {tab === 'AI' && (
            <fieldset>
              <legend>智能整理（全自动）</legend>
              <label className="check">
                <input type="checkbox" checked={s.autoOrganize} onChange={(e) => update({ autoOrganize: e.target.checked })} />{' '}
                自动整理：快照后自动归类新标签，每晚自动调整收藏夹结构（每项变更可撤销）
              </label>
              <Row label="自动归类阈值">
                <select value={String(s.autoOrganizeThreshold)} onChange={(e) => update({ autoOrganizeThreshold: Number(e.target.value) })}>
                  <option value="0.6">60%（更积极）</option>
                  <option value="0.75">75%（推荐）</option>
                  <option value="0.9">90%（更保守）</option>
                </select>
              </Row>
              <Row label="自动分组阈值">
                <select
                  value={String(s.groupThreshold ?? 8)}
                  onChange={(e) => update({ groupThreshold: Number(e.target.value) })}
                  data-testid="group-threshold"
                >
                  {[5, 6, 8, 10, 12, 15, 20].map((n) => (
                    <option key={n} value={String(n)}>
                      同类网址达到 {n} 个就自动建组{n === 8 ? '（推荐）' : ''}
                    </option>
                  ))}
                </select>
              </Row>
              <label className="check">
                <input type="checkbox" checked={s.aiCloudOrganize} disabled={!s.hasAiKey} onChange={(e) => update({ aiCloudOrganize: e.target.checked })} />{' '}
                使用云端 AI 分类、描述、智能搜索改写与问答（会把标题、网址和提取的网页正文片段发送到下方接口，不发送原始 HTML；关闭时所有分析都在本机完成）
              </label>
              <label className="check">
                <input type="checkbox" checked={s.aiFetchPages} onChange={(e) => update({ aiFetchPages: e.target.checked })} data-testid="fetch-pages" />{' '}
                读取网页正文提升 AI 质量（后台限速抓取标题、描述、小标题和首段；关闭则完全离线，只用标题和网址）
              </label>
              {!s.hasAiKey && <p className="muted small">先在下方填写 API Key 才能启用云端 AI。支持 OpenAI 兼容接口：OpenAI、DeepSeek、通义千问、Kimi 等。</p>}
            </fieldset>
          )}
          {tab === 'AI' && (
            <fieldset>
              <legend>智能摘要</legend>
              <p className="muted">
                当前：{s.hasAiKey ? '云端 AI（OpenAI 兼容接口）' : '本地摘要（离线）'}
                {!s.aiKeyEncryptionAvailable && ' · 系统密钥库不可用，可改用环境变量 OPENAI_API_KEY'}
              </p>
              <Row label="API Key">
                <input type="password" value={key} placeholder={s.hasAiKey ? '已设置（输入新值替换）' : 'sk-…'} onChange={(e) => setKey(e.target.value)} />{' '}
                <button
                  className="btn btn-sm"
                  disabled={!key}
                  onClick={() => void app.run(() => call('settings:setAiKey', { key }).then((r) => (setS(r), setKey(''))), '密钥已加密保存')}
                >
                  保存
                </button>
                {s.hasAiKey && (
                  <button className="btn btn-sm" onClick={() => void app.run(() => call('settings:setAiKey', { key: null }).then(setS), '已移除')}>
                    移除
                  </button>
                )}
              </Row>
              <Row label="预设">
                <select
                  value=""
                  onChange={(e) => {
                    const [u, m] = e.target.value.split('|')
                    if (u) update({ aiBaseUrl: u, aiModel: m })
                  }}
                >
                  <option value="">选择服务商…</option>
                  <option value="https://api.openai.com/v1|gpt-4o-mini">OpenAI</option>
                  <option value="https://api.deepseek.com/v1|deepseek-chat">DeepSeek</option>
                  <option value="https://dashscope.aliyuncs.com/compatible-mode/v1|qwen-plus">通义千问</option>
                  <option value="https://api.moonshot.cn/v1|moonshot-v1-8k">Kimi</option>
                  <option value="https://api.typesafe.ai/v1|jev-latest">TypeSafe（Jev，判断/打分型）</option>
                </select>
              </Row>
              <Row label="Base URL">
                <input key={s.aiBaseUrl} defaultValue={s.aiBaseUrl} onBlur={(e) => e.target.value !== s.aiBaseUrl && update({ aiBaseUrl: e.target.value })} />
              </Row>
              <Row label="模型">
                <input
                  key={s.aiModel}
                  defaultValue={s.aiModel}
                  onBlur={(e) => e.target.value && e.target.value !== s.aiModel && update({ aiModel: e.target.value })}
                />
              </Row>
              {/typesafe\.ai/i.test(s.aiBaseUrl) && (
                <p className="muted" data-testid="typesafe-note">
                  TypeSafe Jev 是判断/打分型模型：用于自动分类、识别页面类型、挑选摘要要点；摘要文字由本地根据 Jev 的判断生成。AI
                  问答与查询改写不可用（自动改用智能搜索）。
                </p>
              )}
              <Row label="向量模型">
                <input
                  key={s.aiEmbedModel}
                  defaultValue={s.aiEmbedModel}
                  placeholder="可选，如 text-embedding-3-small / text-embedding-v3（留空用本地向量）"
                  onBlur={(e) => e.target.value !== s.aiEmbedModel && update({ aiEmbedModel: e.target.value.trim() })}
                />
              </Row>
              <Row label="每日用量上限">
                <select value={String(s.aiDailyTokenCap)} onChange={(e) => update({ aiDailyTokenCap: Number(e.target.value) })}>
                  {[50000, 200000, 1000000, 5000000, 0].map((n) => (
                    <option key={n} value={String(n)}>
                      {n ? `${(n / 10000).toLocaleString()} 万 tokens / 天${n === 200000 ? '（推荐）' : ''}` : '不限制'}
                    </option>
                  ))}
                </select>
              </Row>
              <div className="btn-row">
                <button
                  className="btn btn-sm"
                  data-testid="ai-test"
                  disabled={!s.hasAiKey || !s.aiCloudOrganize}
                  onClick={() =>
                    void app.run(
                      () => call('ai:test'),
                      (r) =>
                        r.ok
                          ? `连接正常：${r.model} · ${r.ms} ms${r.embed === null ? '' : r.embed ? ' · 向量模型可用' : ' · 向量模型不可用'}`
                          : `连接失败：${r.error ?? '未知错误'}`
                    )
                  }
                >
                  测试连接
                </button>
                {usage && (
                  <span className="muted small">
                    今日已用 {usage.tokens.toLocaleString()} tokens · {usage.requests} 次请求 · 缓存命中 {usage.cacheHits}
                    {usage.costUsd !== null ? ` · 约 $${usage.costUsd}` : ''}
                  </span>
                )}
              </div>
            </fieldset>
          )}
          {tab === '备份' && (
            <fieldset>
              <legend>备份与数据</legend>
              <label className="check">
                <input type="checkbox" checked={s.autoBackup} onChange={(e) => update({ autoBackup: e.target.checked })} /> 每日自动备份（保留 14 份）
              </label>
              <Row label="备份目录">
                <span className="sel-text">{s.backupDir}</span>{' '}
                <button className="btn btn-sm" onClick={() => void call('settings:chooseBackupDir').then(setS)}>
                  更改…
                </button>
              </Row>
              <div className="btn-row">
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void app.run(
                      () => call('backup:now'),
                      (f) => `已备份到 ${f}`
                    )
                  }
                >
                  立即备份
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void app.run(
                      () => call('backup:exportJson'),
                      (f) => (f ? `已导出 ${f}` : '已取消')
                    )
                  }
                >
                  导出 JSON…
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void app.run(
                      () => call('backup:exportHtml'),
                      (f) => (f ? `已导出 ${f}` : '已取消')
                    )
                  }
                >
                  导出书签 HTML…
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    void app.run(
                      () => call('backup:importJson'),
                      (n) => (n === null ? '已取消' : `已恢复 ${n} 个标签`)
                    )
                  }
                >
                  从备份恢复…
                </button>
              </div>
              <Row label="数据库">
                <span className="sel-text">{s.dataPath}</span>
              </Row>
              <Row label="日志">
                <span className="sel-text">{s.logPath}</span>{' '}
                <button className="btn btn-sm" onClick={() => void call('app:openLogs')}>
                  打开
                </button>
              </Row>
            </fieldset>
          )}
          {tab === '关于' && (
            <div className="about">
              <img src="./icon.png" alt="" width={48} height={48} />
              <div>
                <b>TabNest 页签巢</b>
                <p>版本 {s.version}</p>
                <p className="muted">本地优先的浏览器标签快照与整理工具。数据只保存在本机。</p>
                <button className="btn btn-sm" onClick={() => void app.run(() => call('app:checkUpdates'), '已检查更新')}>
                  检查更新
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
