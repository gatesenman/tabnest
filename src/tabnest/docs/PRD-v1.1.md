# TabNest v1.1 产品需求（PRD）

## 背景
用户真正想要的不是「再开一个会话」，而是：
1. **一天的浏览器状态只有一份**——多次快照不产生垃圾会话；
2. **下班/关机前一键收工**——保存成功才关浏览器，绝不误杀。

## 需求 1：每天一个去重快照

| 项 | 说明 |
|---|---|
| 核心单位 | Daily Snapshot（本地日历日） |
| 合并来源 | 手动、定时自动、关机前、扩展、粘贴链接 |
| 去重键 | `normalizeUrl(url)`（去 www / 跟踪参数 / hash / 尾斜杠） |
| 保留字段 | 最新 title；first_seen / last_seen；sources（browserId::profileId）；seen_count |
| 收藏夹 | 已整理的 tab 继续挂在原 collection；再出现只更新元数据 |
| 时间线 | 一天一张卡：标签数 + 较前一天新增数 |
| 迁移 | 按本地日合并既有会话；未整理的同 URL 折叠为一行 |

## 需求 2：一键快照并关闭所有浏览器

| 项 | 说明 |
|---|---|
| 入口 | 主页醒目按钮、托盘菜单、Ctrl/⌘+K 命令面板 |
| 流程 | 读标签 → 写入今日快照 → 校验（每运行中浏览器 count>0，或用户确认强制）→ 确认对话框 → 优雅关闭 → toast |
| 数据源 | 扩展已连接 → 先请求实时列表；否则读会话文件并在 UI 注明可能滞后 |
| Windows | `taskkill /IM xxx.exe`（无 /F，即 WM_CLOSE）→ 等 ≤10s → 可选 /F |
| macOS | AppleScript `quit` → 必要时 `pkill -9` |
| Linux | `pkill -TERM` → 等 ≤10s → `pkill -KILL` |
| 进程名 | chrome.exe / msedge.exe / brave.exe / vivaldi.exe / opera.exe / firefox.exe（及对应 mac/linux 名） |
| 安全阀 | 某浏览器快照失败（读到 0 且仍在运行）→ **永不关闭**，除非用户勾选强制 |
| 关机选项 | 默认关；设置页开启后，确认对话框再勾选一次；Windows `shutdown /s /t 30` |

## 验收
- [x] 单元测试：日合并、first/last/seen/sources、organized 复用、迁移、dayStats、closeBrowsers SIGTERM
- [x] E2E：扩展两次推送 → 一天一张卡、2 个去重标签；关闭对话框出现；长轮询握手成功
- [x] README / CHANGELOG / DEVELOPMENT 已更新
