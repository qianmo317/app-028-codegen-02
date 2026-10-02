/** 数据模型（对应规格书 §7） */

export type PaperKind = 'sheet' | 'roll'

export interface Paper {
  id: string
  name: string
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  kind: PaperKind
}

export interface PhotoSize {
  id: string
  name: string
  wMm: number
  hMm: number
  rotateByDefault: boolean
}

/** 本机读取的照片文件信息（只读尺寸与方向，不上传） */
export interface PhotoRef {
  name: string
  wPx: number
  hPx: number
  landscape: boolean
}

export interface Item {
  id: string
  sizeId: string
  qty: number
  rotateAllowed: boolean
  /** true = 同一张照片重复排；false = 一张照片只出现一次（每张各需一张底片） */
  repeatSamePhoto: boolean
  /** true = 该尺寸的照片尽量不拆散，排在同一张相纸上 */
  keepTogether: boolean
  photo?: PhotoRef
}

/** 实际照片矩形（mm，含旋转后的宽高） */
export interface Placement {
  itemId: string
  sheetIndex: number
  x: number
  y: number
  w: number
  h: number
  rotated: boolean
  seq: number
}

export type CutAxis = 'v' | 'h'

/** 贯通切割线；axis='v' 时 at 为 x，from/to 为 y 区间 */
export interface CutStep {
  sheetIndex: number
  axis: CutAxis
  at: number
  from: number
  to: number
  /** 该步由共边合并而来 */
  merged: boolean
}

export interface Sheet {
  index: number
  placements: Placement[]
  cutSteps: CutStep[]
  /** 合并前的切割步数（用于共边合并的对比断言） */
  rawCutCount: number
  usedAreaMm2: number
  sheetAreaMm2: number
  utilization: number
  wasteRects: WasteRect[]
}

export interface WasteRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PackStats {
  totalPhotos: number
  sheets: number
  avgUtilization: number
  elapsedMs: number
  keepTogetherBroken: string[]
}

export interface PackResult {
  sheets: Sheet[]
  stats: PackStats
}

export interface CostReport {
  paperName: string
  sheets: number
  totalCents: number
  perPhotoCents: number
  totalPhotoCount: number
  /** 本方案浪费率 */
  wasteRate: number
  /** 不排样逐张打印的浪费率 */
  naiveWasteRate: number
  naiveTotalCents: number
  savedCents: number
}

export interface Task {
  id: string
  name: string
  paperId: string
  /** 自定义相纸（paperId 为 'custom' 时生效） */
  customPaper?: Paper
  items: Item[]
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
  headerText: string
  footerText: string
  createdAt: number
  /** 手工微调过的排样（存在时优先于自动排样结果） */
  manual?: {
    placements: Placement[]
    valid: boolean
    message: string
    validationMs: number
    stepCount: number
  }
  result?: PackResult
}

export interface Leftover {
  id: string
  name: string
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  createdAt: number
  usedCount: number
}

/* ---------- 批次库存台账 ---------- */

/** 入库计量单位：sheet=按包（每包若干张），roll=按卷（每卷可切若干张） */
export type BatchUnit = 'sheet' | 'roll'

/** 一批相纸：同规格、同入库日期、同采购单价记为一批 */
export interface PaperBatch {
  id: string
  /** 批次标签（如 202609-A，随手贴在包装上对号） */
  ref: string
  /** 规格来源相纸 id（自定义规格可能为 'custom'；真正扣减按 wMm×hMm 匹配） */
  paperId: string
  paperName: string
  wMm: number
  hMm: number
  kind: PaperKind
  /** 入库按「包」还是「卷」计 */
  unit: BatchUnit
  /** 入库包数 / 卷数 */
  qtyIn: number
  /** 每包张数 / 每卷可切张数 */
  unitsPer: number
  /** 入库日期（ms，0 点） */
  inAt: number
  /** 有效期（ms，0 点；0 = 不设有效期） */
  expiresAt: number
  /** 采购单价：每包 / 每卷的价格（分） */
  pricePurchaseCents: number
  note?: string
}

/** 一笔扣减在某一批上的分摊量与该批实际单价 */
export interface BatchAlloc {
  batchId: string
  /** 从该批扣掉的相纸单位数（张/切张） */
  units: number
  /** 扣减时该批的单位单价快照（分，允许半分等小数） */
  unitPriceCents: number
}

export type ConsumptionStatus = 'active' | 'reverted'

/** 一次排样消耗的扣减记录：一个任务在同一排样结果下只允许有一条 active 记录 */
export interface Consumption {
  id: string
  taskId: string
  taskName: string
  paperId: string
  paperName: string
  wMm: number
  hMm: number
  kind: PaperKind
  /** 实际扣减时刻（决定归属哪个时间段） */
  at: number
  /** 排样当时估的张数（扣减瞬间快照） */
  unitsEstimated: number
  /** 先进先出扣到的批次（按扣减顺序）；库存不足时总 units 小于 unitsEstimated */
  allocs: BatchAlloc[]
  /** 按各批实际单价汇总的材料成本（分） */
  totalCents: number
  status: ConsumptionStatus
  revertedAt?: number
  /** 退还原因：任务删除 / 重排换纸 / 手工退还 */
  reason?: string
}

export interface Settings {
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
  exportDpi: number
}

export interface PaperTemplate {
  id: string
  name: string
  paperId: string
  items: Array<{
    sizeId: string
    qty: number
    rotateAllowed: boolean
    keepTogether: boolean
  }>
}
