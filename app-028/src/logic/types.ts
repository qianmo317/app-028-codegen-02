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
  /** 第一次排样定下的相纸张数（排样当时的估算，月底与实际扣减对比用） */
  initialSheetCount?: number
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

/* ===================== 库存台账 ===================== */

/** 入库单位：散张 / 包 / 卷 */
export type StockUnit = 'sheets' | 'pack' | 'roll'

/** 一批相纸（同规格、同进价、同有效期的一包/几包或一卷/几卷） */
export interface PaperBatch {
  id: string
  /** 批次号，手填或自动生成，如 202610-01 */
  code: string
  /** 规格名称（取自相纸库，或手填） */
  paperName: string
  wMm: number
  hMm: number
  kind: PaperKind
  /** 入库日期 YYYY-MM-DD */
  inDate: string
  /** 有效期至 YYYY-MM-DD（可空） */
  expireDate: string
  /** 入库数量（散张数 / 包数 / 卷数） */
  units: number
  unit: StockUnit
  /** 每包/每卷折合多少张（unit='sheets' 时恒为 1） */
  sheetsPerUnit: number
  /** 采购单价：unit='sheets' 时为每张价；pack/roll 时为每包/每卷价（分） */
  priceCents: number
  note: string
}

/** 一次消耗对某一批的扣减明细（FIFO 下一次消耗可跨多批） */
export interface StockAllocation {
  batchId: string
  /** 从该批扣了几张 */
  sheets: number
  /** 扣减时刻该批每张成本（分，可能含小数，如 1/3 分） */
  unitCostCents: number
  /** 该条明细成本（分，按每张全精度累加，展示时四舍五入） */
  lineCostCents: number
}

/** 一笔相纸消耗（与排样任务关联；posted 已扣、void 已还） */
export interface StockConsumption {
  id: string
  /** 关联任务 */
  taskId: string
  taskName: string
  /** 规格快照 */
  paperName: string
  wMm: number
  hMm: number
  kind: PaperKind
  /** 消耗日期 YYYY-MM-DD（默认扣减当天） */
  date: string
  /** 排样当时估的张数（任务第一次排样结果） */
  estimatedSheets: number
  /** 实际扣减张数（= Σ allocations.sheets） */
  actualSheets: number
  /** 实际成本（分，= Σ allocations.lineCostCents） */
  actualCostCents: number
  allocations: StockAllocation[]
  /** posted = 已从库存扣减（一笔只能扣一次）；void = 任务删除/重排/手工还回 */
  status: 'posted' | 'void'
  voidedAt?: number
  voidReason?: string
  createdAt: number
}

