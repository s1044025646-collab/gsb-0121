# odet — 本地目标检测评测与误检归因后端

只处理结构化坐标（不读取真实图片、不训练模型、不调用外部视觉服务）。
提供：HTTP API、CLI、确定性合成数据生成器、自动化测试。

## 技术栈与运行要求

- Node.js >= 25（使用内置 `node:sqlite`，无需原生编译；Node 22.5+ 需 `--experimental-sqlite`）
- TypeScript（用 `tsx` 直接运行，测试用 `vitest`）
- Express + zod（HTTP 与参数校验）、commander（CLI）

所有数据、SQLite 文件、导出与临时文件都写在本项目目录（默认 `data/`，演示输出 `demo-out/`）。
HTTP 服务只绑定 `127.0.0.1`，默认自动选择空闲端口（可用 `ODET_PORT` 指定）。

## 安装

```bash
npm install
```

## 测试

```bash
npm test
```

测试覆盖：矩形 IoU、可手算的匹配 / PR 曲线 / AP、多阈值 mAP、完美预测、全漏检、
密集重叠目标、重复预测、分数并列稳定顺序、类别映射改变、空图片、越界框与无效尺寸
失败路径、导入幂等、事务回滚、冻结报告不可变、重启后持久化、API 错误码与分页。

类型检查：

```bash
npx tsc --noEmit
```

## 启动 / 停止服务

```bash
npm start
```

启动后控制台打印形如 `listening on http://127.0.0.1:53905 (db: data/odet.sqlite)`。
仅监听本机回环地址；停止按 `Ctrl+C`（会关闭 HTTP 服务与数据库连接，只管理本进程）。

可选环境变量：

- `ODET_DB`：SQLite 文件路径（默认 `data/odet.sqlite`）
- `ODET_PORT`：固定本机端口（默认自动选取空闲端口）

## 可重复端到端演示

```bash
npm run demo
```

演示使用固定种子生成合成数据，创建数据集版本、两个模型版本、一个标注修订版本，
运行多阈值评测、模型对比并打印分页错误样本。同一种子每次结果完全一致。

## CLI

CLI 每个写操作都会打印操作前后的计数状态；重复提交相同幂等键返回原记录并标注
`(idempotent replay)`。

```bash
# 1) 生成合成标注 + 预测（确定性种子）
npx tsx src/cli.ts generate --out-dir demo-out --seed 42 --images 8

# 2) 导入标注（每次导入都是不可变的新数据集版本；修订请重新导入）
npx tsx src/cli.ts import-annotations --file demo-out/annotations.json \
  --name syn-v1 --note "initial" --idempotency-key ds-42

# 3) 导入某模型版本在该数据集版本上的预测
npx tsx src/cli.ts import-predictions --file demo-out/predictions.json \
  --model mA --dataset-version-id 1 --idempotency-key ds-42-mA

# 4) 创建评测方案（阈值逗号分隔；PowerShell 下亦兼容空格分隔）
npx tsx src/cli.ts create-scheme --name std --thresholds 0.5,0.75

# 5) 运行评测，生成冻结报告
npx tsx src/cli.ts evaluate --model-version-id 1 --dataset-version-id 1 --scheme-id 1

# 6) 分页查看可归因错误样本（可按类型/类别/图片过滤）
npx tsx src/cli.ts errors --report-id 1 --page 0 --page-size 20
npx tsx src/cli.ts errors --report-id 1 --type localization

# 7) 同一数据集版本 + 同一方案下比较两个模型版本
npx tsx src/cli.ts compare --model-a 1 --model-b 2 --dataset-version-id 1 --scheme-id 1

# 8) 导出冻结报告 JSON
npx tsx src/cli.ts export-report --report-id 1 --out demo-out/report.json
```

标注 / 预测 JSON 是数组（或 `{ "images": [...] }` / `{ "predictions": [...] }`）：

```json
[
  {
    "externalId": "img_0000",
    "width": 640,
    "height": 480,
    "gt": [
      { "left": 10, "top": 20, "right": 50, "bottom": 80, "category": "cat" }
    ]
  }
]
```

```json
[
  {
    "externalId": "img_0000",
    "boxes": [
      { "left": 12, "top": 21, "right": 49, "bottom": 78, "category": "cat", "confidence": 0.93 }
    ]
  }
]
```

## HTTP API

所有请求/响应为 JSON；校验失败返回 `{ "error": { "code", "message", "details" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/datasets` | 创建不可变数据集版本（支持 `idempotencyKey`） |
| POST | `/predictions` | 导入模型预测（支持 `idempotencyKey`） |
| POST | `/schemes` | 创建评测方案 |
| POST | `/reports` | 运行评测并冻结报告（相同输入复用同一条报告） |
| GET | `/reports/:id` | 获取冻结报告 |
| GET | `/reports/:id/errors` | 分页错误样本：`page`、`pageSize`、`type`、`category`、`image`、`iouThreshold` |
| POST | `/compare` | 同数据集 + 同方案下比较两个模型版本 |
| GET | `/models` / `/datasets` | 列表查询 |

主要错误码：`VALIDATION_ERROR`、`INVALID_DIMENSION`、`OUT_OF_BOUNDS`、`NOT_FOUND`、
`CONFLICT`、`RULE_MISMATCH`（HTTP 分别映射为 400 / 404 / 409）。

## 评测规则（明确约定）

**矩形 IoU**：交集面积 / 并集面积；无交集或并集面积非正时返回 0，绝不抛零除。

**排序与一对一匹配**：预测按置信度降序消费；同分时按 `(图片顺序, 图片内原始序号)`
稳定决胜，保证任何重放结果一致。每个真实框在一个 IoU 阈值下最多被命中一次
（贪心一对一：取同类、未占用且 IoU 最高且达阈值的真实框）。

**PR 曲线与插值**：

- `all_point`（默认，COCO 风格阶梯插值）：先对精度做从尾部向前取 running-max 的
  单调包络；`AP = Σ (r_n − r_{n−1}) · p_interp(r_n)`，`r_0 = 0`，只在召回率上升处累计。
- `11_point`（PASCAL VOC 风格）：在召回率 `0, 0.1, …, 1.0` 共 11 个点取
  `p_interp` 后求平均。
- 类别没有任何真实框时召回率无定义，AP 记 0；默认在 mAP 均值中**排除**无 GT 类别
  （创建方案时可显式改为计入 0）。

**汇总顺序**：先对每个 IoU 阈值计算各类 AP 的算术平均（macro，类别等权）得到
`mAP@t`；再对所有阈值取算术平均得到总体 `mAP`（如 `[0.5, 0.75]` 即两者均值；
COCO 风格可传 10 个阈值 0.5–0.95）。

**错误归因（逐样本、可追查图片/类别/框/分数/IoU）**：

- `missed_gt`：阈值下没有任何预测匹配该真实框。
- `duplicate`：同类且 IoU 达阈值，但对应真实框已被更早（高分）预测占用。
- `localization`：与同类真实框有重叠但 IoU 低于阈值。
- `wrong_class`：与异类真实框 IoU 达阈值（同时该异类真实框记 `missed_gt`）。
- `background_fp`：没有任何达阈值的真实框重叠（纯背景误检）。

**边界与完整性**：

- 空图片（无 GT 且无预测）不产生错误；无预测图片只会产生 `missed_gt`。
- 越界框、零/负面积框、非正/非整数尺寸、越界置信度一律拒绝并给出明确错误码，
  绝不静默裁剪或夹断。
- 数据集版本、报告均不可变；标注修订产生新版本，旧报告永不被改写
  （报告按模型 + 数据集版本 + 方案 + 规范化输入哈希去重冻结）。
- 导入按 `idempotencyKey` 幂等；多表写入在单个事务内完成，失败整体回滚。
- 迁移用 `CREATE TABLE/INDEX IF NOT EXISTS`，可重复执行；重启后状态持久化。
