# dsh-paper-agent · 文献助手

DeepSeek Harness（DSH）插件：一个页面、两个分页，把「按研究方向找论文 → 打分筛选 → 卡片式阅读 → 反馈校准」串成一条本地流水线。

- **文献拉取**：按研究方向从 OpenAlex 拉取论文，去重入库；支持文字检索 / Topics / Keywords 三种方式，可用一句话自动生成方向。
- **文献卡片台**：只看未读卡片，逐张评分、写评语；左侧按方向筛选，可回顾已评分 / 被筛掉的文献。
- **AI 一键筛选**：调用 DSH 当前模型打分并生成中文标题、内容梳理、小师妹点评、摘要翻译；筛选时会参考你的历史评分与评语。
- 全部状态保存在本地工作区，不下载 PDF，不上传数据。

## 环境要求

- DeepSeek Harness 0.2.x（桌面版）
- 一个 OpenAlex 免费 API key（每天 10,000 次请求；面板里可以用邮箱一键申请）
- 一个可用的 DSH 默认模型（设置 → Models），AI 配置 / 筛选需要它

## 安装

```bash
# 本地目录
dsh plugin --profile desktop add /absolute/path/to/dsh-paper-agent

# 或从 GitHub（换成实际仓库地址）
dsh plugin --profile desktop add github:<owner>/dsh-paper-agent
```

安装后**重启该 profile**。左侧栏会出现「文献助手」。

## 第一次使用

1. 打开「文献助手 → 文献拉取」，在设置里填**工作区路径**（例如 `D:\Papers`）；
2. 配置 OpenAlex key：
   - 推荐：填邮箱 → 点「申请并保存」→ 去邮箱点激活链接 → 回面板点刷新；
   - 也可以直接粘贴已有的 key；
3. 「一键配置方向」：用一句话描述研究方向，选择检索方式（自动 / 文字 / Topics / Keywords），点「自动配置」；
4. 测试拉取 → 拉取；
5. 「一键筛选」选篇数（1/5/10/20 或自定义），等待进度完成；
6. 切到「文献卡片台」：看看推荐 / 待读列表，逐张评分、写评语。

## 反馈如何改进筛选

- 卡片台的评分与评语会写入本地反馈库；
- 每次「一键筛选」自动把**最近的高分/低分例子、评语、偏好摘要**注入提示词，让打分贴近你的口味；
- 反馈变化 ≥2 条时自动重算偏好摘要，也可以在「设置 → 反馈学习」手动更新；
- 不想要这个影响时，取消勾选「筛选时使用我的历史评分 / 评语」。

> 评语比评分更有用：一句「纯模拟的不要」「这套工艺路线想跟进」会直接成为筛选标准。

## 数据与隐私

- 数据只写在你指定的工作区 `<workspace>/.paper-agent/`（可用插件配置 `stateDir` 修改）：
  - `directions.json` 方向配置
  - `library.jsonl` 文献库（OpenAlex ID + DOI 去重）
  - `screenings.jsonl` 筛选评分与中文内容
  - `feedback.jsonl` / `feedback-notes.jsonl` 你的评分与评语
  - `preferences.json` 偏好摘要
  - `pull-state.json` / `usage.json` 拉取状态与额度
  - `exports/` 原始候选备份
- API key 只保存在本机工作区的 `settings.json`，不写进插件包、不上传；
- 插件本身不含任何本机路径或密钥，可以直接分享给他人安装。

## 本地数据通道

DSH 桌面壳的 Web 服务只接受 GET/HEAD（POST 会 405），因此插件在 host 侧启动一个只绑定 `127.0.0.1` 的小服务（端口 43117–43126，自动选空闲），面板启动时自动探测。

- 面板提示「本地数据通道未启动」：确认插件已安装并重启 DSH；仍不行检查端口是否被占用。
- 一键配置 / 一键筛选提示「没有可用的模型服务」：去 DSH「设置 → Models」选一个默认模型。

## OpenAlex 免费计划的约束

- 不能用 `from_created_date` / `from_updated_date` 过滤或按 created/updated 排序（付费功能，会 429）；
- 可用：`from_publication_date` / `to_publication_date`、`topics.id`、`keywords.id`、`title_and_abstract.search`、`type`、`sort=publication_date`；
- `per_page` 最大 100；免费 key 每天 10,000 请求，UTC 午夜重置；
- 多数期刊只提供「年月」，所以拉取窗口按月对齐；「新论文」由本地 `firstSeen` 判断。

## 开发与自检

```bash
npm test            # 离线自检：渲染、数据服务、本地通道、假模型 AI 链路
```

要求 Node ≥ 20。插件零第三方运行时依赖，只使用 Node 内置模块；宿主能力（工具注册、模型调用）通过 DSH 服务注入。

## 许可

MIT
