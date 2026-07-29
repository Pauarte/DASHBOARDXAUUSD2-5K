export type AnalysisStatus = 'normal' | 'watch' | 'alert' | 'insufficient_data'

export interface DailyAnalysis {
  schema_version: 1
  date: string
  generated_at: string
  bot: 'R2-A'
  status: AnalysisStatus
  summary: string
  data_freshness: {
    last_sync_at: string | null
    age_seconds: number | null
    is_stale: boolean
  }
  metrics: {
    balance: number | null
    equity: number | null
    daily_pnl: number | null
    daily_return_pct: number | null
    closed_operations: number | null
    wins: number | null
    losses: number | null
    win_rate_pct: number | null
    open_positions: number | null
    floating_pnl: number | null
    worst_floating_day: number | null
  }
  assessment: {
    performance: string
    risk: string
    execution: string
    conclusion: string
  }
  alerts: string[]
  sources: string[]
}

const REPORTS_REPOSITORY = 'Gartecz/R2A-Analisis-Diaris'
const TREE_URL = `https://api.github.com/repos/${REPORTS_REPOSITORY}/git/trees/main?recursive=1`
const RAW_BASE = `https://raw.githubusercontent.com/${REPORTS_REPOSITORY}/main`
const REPORT_PATH = /^analisis\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.json$/

interface GitHubTreeResponse {
  tree?: Array<{ path?: string; type?: string }>
}

function isDailyAnalysis(value: unknown): value is DailyAnalysis {
  if (!value || typeof value !== 'object') return false
  const report = value as Partial<DailyAnalysis>
  return (
    report.schema_version === 1 &&
    report.bot === 'R2-A' &&
    typeof report.date === 'string' &&
    typeof report.summary === 'string' &&
    Boolean(report.metrics) &&
    Boolean(report.assessment)
  )
}

export async function fetchAnalysisDates(): Promise<string[]> {
  const treeResponse = await fetch(TREE_URL, { cache: 'no-store' })
  if (!treeResponse.ok) throw new Error(`GitHub ha respost ${treeResponse.status}`)

  const tree = (await treeResponse.json()) as GitHubTreeResponse
  return (tree.tree ?? [])
    .filter((entry) => entry.type === 'blob' && entry.path)
    .map((entry) => entry.path?.match(REPORT_PATH)?.[3] ?? null)
    .filter((date): date is string => date !== null)
    .sort((a, b) => b.localeCompare(a))
}

export async function fetchDailyAnalysesForMonth(
  month: string,
  availableDates: string[],
): Promise<DailyAnalysis[]> {
  const dates = availableDates.filter((date) => date.startsWith(`${month}-`))

  const reports = await Promise.all(
    dates.map(async (date) => {
      const [year, monthNumber] = date.split('-')
      const path = `analisis/${year}/${monthNumber}/${date}.json`
      const response = await fetch(`${RAW_BASE}/${path}`, { cache: 'no-store' })
      if (!response.ok) return null
      const value: unknown = await response.json()
      return isDailyAnalysis(value) ? value : null
    }),
  )

  return reports
    .filter((report): report is DailyAnalysis => report !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
}
