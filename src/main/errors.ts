/** 统一错误模型：主进程所有异常都归一到 CmsError，IPC 层再转成 { ok:false, code, message, hint } 供 UI 映射。 */
export type ErrorCode =
  | 'INTERNAL'
  | 'PATH_ESCAPE'
  | 'INVALID_SLUG'
  | 'INVALID_SECTION'
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_NO_CONTENT'
  | 'FS_ERROR'
  | 'FRONTMATTER_PARSE'
  | 'NO_FRONTMATTER'
  | 'ENTRY_NOT_FOUND'
  | 'INVALID_FIELD'
  | 'VALIDATION_FAILED'
  | 'LAST_ITEM_PROTECTED'
  /** 乐观锁：磁盘文件在读取后被外部改动，拒绝覆盖 */
  | 'CONFLICT'
  | 'WRITE_FAILED'
  /** 工作区不是 Git 仓库 */
  | 'GIT_NOT_REPO'
  /** 被提交的文件清单不安全（通配 / 绝对路径 / -A 等） */
  | 'GIT_UNSAFE_PATH'
  /** 远端凭据被拒 */
  | 'GIT_AUTH'
  /** 网络 / 代理不可达 */
  | 'GIT_NETWORK'
  /** 远端有新提交，push 被拒（non-fast-forward） */
  | 'GIT_REJECTED'
  | 'GIT_FAILED'
  /** 预检未全绿，禁止进入发布 */
  | 'PREFLIGHT_FAILED'
  /** 未获得人工确认（Git 闸门核心） */
  | 'CONFIRM_REQUIRED'
  /** 新建条目时目标文件已存在 */
  | 'ENTRY_EXISTS'
  /** 部署回读配置缺失（仓库标识 / Token / 项目 ID） */
  | 'DEPLOY_CONFIG'
  /** 部署回读的 HTTP 请求失败（含非 2xx） */
  | 'DEPLOY_HTTP'
  /** 按 SHA 未查到对应部署 */
  | 'DEPLOY_NOT_FOUND'

export class CmsError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly hint?: string,
    /** 结构化补充信息（如冲突时的磁盘版本），随 IPC 信封透传给 UI */
    public readonly detail?: unknown
  ) {
    super(message)
    this.name = 'CmsError'
  }
}