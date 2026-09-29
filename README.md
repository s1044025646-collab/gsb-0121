# odet — 本地目标检测评测与误检归因后端

一个**仅在本机运行**的后端：管理结构化的标注框、预测框、数据集/模型版本、评测方案与冻结报告，
自行实现矩形 IoU、一对一匹配、精确率-召回率曲线、逐类 AP 与多 IoU 阈值 mAP，并对漏检、
重复框、定位不准、类别错误给出可追查的样本依据。

不包含网页、模型训练或任何外部视觉服务；只处理结构化坐标，不需要真实图片。

## 技术栈

- TypeScript + Node.js（`--experimental-strip-types`，运行时零第三方包）
- 内置 `node:sqlite`（`DatabaseSync`），无需原生编译
- 内置 `node:test` 测试框架与全局 `fetch`
- 仅开发依赖：`typescript`、`@types/node`

要求 **Node.js >= 22.5**（开发验证于 Node 25）。

## 安装

```powershell
npm install
```

## 计算规则（明确约定）

- **IoU**：标准交并比；输入框保证正面积，并集体由严格校验保证，代码路径不会出现零除。
- **匹配**：按置信度从高到低的一对一贪心匹配；同分时按 `分数降序 → imageId 升序 → 预测框 id 升序`
  打破并列，因此与输入数组顺序无关、可稳定复现。一个真实框最多被一个预测框命中。
- **PR 曲线**：按匹配顺序逐条纳入预测；第 k 点阈值取第 k 条预测的分数，`precision=TP/(TP+FP)`，
  `recall=TP/GT总数`。
- **AP**：PASCAL VOC **11 点插值**。`p_inter(r_j)=max{ precision(recall>=r_j) }`，
  `r_j∈{0,0.1,…,1}`，AP 为 11 个值的平均。
- **mAP**：只对**至少有一个真实框的类别**取平均；没有真实目标的类别记为 0、单列展示但不进入均值。
  多 IoU 阈值时，报告总体 mAP 为各阈值 mAP 的算术平均；逐阈值结果同时保留。
- **误检归因（互斥，按优先级）**：
  - `wrong_class`：与其他类别真实框 IoU ≥ `wrongClassIou`（默认 0.1）。
  - `duplicate`：与同类、已被更高分预测占用的真实框 IoU ≥ `duplicateIou`（默认 0.5）。
  - `localization`：与同类真实框有重叠但 IoU 低于匹配阈值。
  - `background_fp`：无任何重叠，背景/空图上的误报。
  - `missed`：真实框从未在匹配阈值上被命中。
  每条记录都带 `imageId/imageKey、categoryId、gtId、predId、iou、score、detail`，可追查。
- **严格数据卫生**：越界框、非正尺寸、非法分数（不在 [0,1]）、非法图片尺寸一律报错；
  不做静默裁剪或吞错。空图片（无框）与无真实目标的类别作为正常情形单独处理。

## 版本、幂等与冻结

- 数据集导入内容做规范化 SHA-256：**内容相同即返回既有版本（幂等重放）**；标注修订产生新 `version`。
- 预测提交同样按 `(模型名, 数据集版本, 全部预测内容)` 哈希去重，重复提交幂等。
- 评测对 `(数据集版本, 模型版本, 方案哈希, 结果)` 哈希去重；报告写入后 `frozen=1`，永不改写，
  因此标注修订不会影响旧报告。
- 模型比较强制要求两报告使用**同一数据集版本**与**同一评测方案**，否则返回 `RULE_MISMATCH`。
- 迁移可重复执行（`schema_migrations` 记录版本，已应用则跳过）。

## 环境变量

- `ODET_DB`：SQLite 文件路径，默认 `data/odet.sqlite`。
- `ODET_PORT`：监听端口，默认 `0`（由系统分配自动端口）。

所有数据库与临时文件都写入项目内的 `data/`。

## 启动 / 停止（仅本机）

服务器只绑定 `127.0.0.1`，默认使用系统分配的自动端口；端口与 pid 写入 `data/server.json`。

```powershell
npm start                 # 启动；查看输出或 data/server.json 获取端口
npm run stop              # 仅向 data/server.json 记录的本项目 pid 发 SIGTERM
```

健康检查：

```powershell
$port = (Get-Content data/server.json | ConvertFrom-Json).port
Invoke-RestMethod "http://127.0.0.1:$port/api/health"
```

停止脚本只读取并终止本项目记录的 pid，不会扫描或结束其它进程。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/datasets` | 导入（或幂等返回）数据集版本 |
| `POST` | `/api/predictions` | 导入模型版本与预测 |
| `POST` | `/api/protocols` | 创建/去重评测方案（IoU 阈值列表等） |
| `POST` | `/api/evaluations` | 运行评测，返回/复用冻结报告 |
| `GET` | `/api/reports?page=&pageSize=` | 分页列出报告 |
| `GET` | `/api/reports/:id` | 报告详情（逐阈值、逐类 AP） |
| `GET` | `/api/reports/:id/errors?kind=&iouThreshold=&categoryId=&page=&pageSize=` | 分页查询错误样本 |
| `GET` | `/api/compare/:a/:b` | 比较两版模型（强制同数据集同规则） |
| `GET` | `/api/health` | 健康检查 |

错误统一为 `{ "error": { "code", "message" } }`，常用码：`VALIDATION`、`INVALID_JSON`、
`INVALID_DIMENSION`(422)、`INVALID_BOX`(422)、`BOX_OUT_OF_BOUNDS`(422)、`INVALID_SCORE`(422)、
`NOT_FOUND`(404)、`RULE_MISMATCH`(409)、`CONFLICT`(409)、`INVALID_PAGINATION`(400)。

### 请求体示例

数据集：

```json
{
  "slug": "tiny",
  "categories": [{ "id": 1, "name": "cat" }],
  "images": [
    { "key": "i0", "width": 100, "height": 100,
      "boxes": [{ "categoryId": 1, "x": 0, "y": 0, "w": 10, "h": 10 }] },
    { "key": "i1", "width": 100, "height": 100, "boxes": [] }
  ]
}
```

预测：

```json
{
  "modelName": "model-a",
  "datasetVersionId": 1,
  "predictions": [
    { "imageKey": "i0", "categoryId": 1, "score": 0.9, "x": 0, "y": 0, "w": 10, "h": 10 }
  ]
}
```

方案与评测：

```json
{ "name": "voc", "iouThresholds": [0.5, 0.75], "wrongClassIou": 0.1, "duplicateIou": 0.5 }
```

```json
{ "datasetVersionId": 1, "modelVersionId": 1, "protocolId": 1 }
```

## CLI

```powershell
npm run cli -- migrate
npm run cli -- import-dataset data/cli/ds.json
npm run cli -- import-predictions data/cli/p1.json
npm run cli -- create-protocol data/cli/proto.json
npm run cli -- evaluate --dataset 1 --model 1 --protocol 1
npm run cli -- reports
npm run cli -- report 1
npm run cli -- errors 2 --kind missed
npm run cli -- compare 1 2
npm run cli -- export 2 --out data/cli/report2.json
```

写操作在执行前后打印关键计数（如 `reports`、`dataset_versions` 数量），幂等命中会标注
`(idempotent replay)` / `(frozen replay)`。

## 可重复演示与测试

```powershell
npm run demo      # 使用固定种子的合成数据，端到端跑好/坏两个模型与比较
npm test          # 21 个自动化测试
npm run build     # TypeScript 严格类型检查（noEmit）
```

测试夹具覆盖：完美预测、全漏检、密集重叠目标、重复预测、同分并列、类别映射改变、空图片、
无真实目标类别、越界框、无效尺寸、非法分数；并用可手算的小数据核对匹配、曲线与 AP（例如
TP/FP 序列 `[1,0]`、GT=2 时 11 点 AP 恰为 `6/11`）。同时覆盖失败路径、事务回滚、幂等重放、
重启后持久化，以及 HTTP 层的状态码与分页。合成生成器使用可注入种子的 mulberry32，时间通过
`now()` 注入，因此同一输入重放结果完全一致。

## 目录结构

```
src/
  core/        geometry(IoU/校验) · matching(一对一匹配/归因) · metrics(PR/AP/mAP) · errors · types
  db/          schema(迁移 SQL) · database(打开+迁移) · tx(显式事务/保存点)
  services/    catalog · models · protocols · evaluate · queries · serial(规范化哈希)
  synth/       可播种的合成标注/预测生成器
  api/         HTTP 路由与错误/分页
  cli/         命令行
  server.ts    本机 HTTP 服务入口
  demo.ts      可重复端到端演示
scripts/stop.mjs  仅停止本项目记录的服务进程
data/          运行期数据库与导出（已 gitignore）
```
