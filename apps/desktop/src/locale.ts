/** Native shell text is independent of the renderer and available before it loads. */
export const DESKTOP_LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja'] as const;
export type DesktopLocale = (typeof DESKTOP_LOCALES)[number];
export const DEFAULT_DESKTOP_LOCALE: DesktopLocale = 'zh-CN';

export function isDesktopLocale(value: unknown): value is DesktopLocale {
  return typeof value === 'string' && DESKTOP_LOCALES.includes(value as DesktopLocale);
}

const messages = {
  file: ['文件', '檔案', 'File', 'ファイル'],
  edit: ['编辑', '編輯', 'Edit', '編集'],
  view: ['视图', '檢視', 'View', '表示'],
  help: ['帮助', '說明', 'Help', 'ヘルプ'],
  back: ['返回应用', '返回應用程式', 'Back to app', 'アプリに戻る'],
  hide: ['隐藏到托盘', '隱藏至系統匣', 'Hide to tray', 'トレイに隠す'],
  undo: ['撤销', '復原', 'Undo', '元に戻す'],
  redo: ['重做', '重做', 'Redo', 'やり直す'],
  cut: ['剪切', '剪下', 'Cut', '切り取り'],
  copy: ['复制', '複製', 'Copy', 'コピー'],
  paste: ['粘贴', '貼上', 'Paste', '貼り付け'],
  selectAll: ['全选', '全選', 'Select all', 'すべて選択'],
  reload: ['重新加载', '重新載入', 'Reload', '再読み込み'],
  actualSize: ['实际大小', '實際大小', 'Actual size', '実際のサイズ'],
  zoomIn: ['放大', '放大', 'Zoom in', '拡大'],
  zoomOut: ['缩小', '縮小', 'Zoom out', '縮小'],
  fullscreen: ['切换全屏', '切換全螢幕', 'Toggle fullscreen', '全画面表示を切り替え'],
  homepage: ['项目主页', '專案首頁', 'Project homepage', 'プロジェクトのホームページ'],
  about: ['关于 Selbstlauf', '關於 Selbstlauf', 'About Selbstlauf', 'Selbstlauf について'],
  openMain: ['打开主界面', '開啟主介面', 'Open main window', 'メイン画面を開く'],
  settings: ['设置', '設定', 'Settings', '設定'],
  startup: ['开机自启', '開機自動啟動', 'Start at login', 'ログイン時に起動'],
  quit: ['退出', '結束', 'Quit', '終了'],
  unknownWindow: ['无法识别请求窗口。', '無法識別請求視窗。', 'The requesting window could not be identified.', '要求元のウィンドウを識別できません。'],
  sessionInvalid: ['会话编号无效。', '工作階段編號無效。', 'Invalid session ID.', 'セッション ID が無効です。'],
  terminalUnavailable: ['当前应用未提供打开终端功能。', '目前應用程式未提供開啟終端機功能。', 'This app cannot open terminal windows.', 'このアプリではターミナルを開けません。'],
  agentInvalid: ['智能体窗口编号无效', '智慧代理視窗編號無效', 'Invalid agent window ID', 'エージェントウィンドウの ID が無効です'],
  agentsUnsupported: ['当前服务尚未支持独立智能体窗口', '目前服務尚未支援獨立智慧代理視窗', 'This service does not support separate agent windows', 'このサービスは独立したエージェントウィンドウに対応していません'],
  serviceStarting: ['服务正在启动，请稍后重试', '服務正在啟動，請稍後再試', 'The service is starting. Please try again shortly.', 'サービスを起動中です。しばらくしてから再試行してください。'],
  serviceUnavailable: ['服务尚未启动。', '服務尚未啟動。', 'The service is not running.', 'サービスが起動していません。'],
  sessionsReadFailed: ['无法读取会话列表：{detail}', '無法讀取工作階段清單：{detail}', 'Could not read the session list: {detail}', 'セッション一覧を取得できません：{detail}'],
  agentsReadFailed: ['无法读取智能体窗口：{detail}', '無法讀取智慧代理視窗：{detail}', 'Could not read agent windows: {detail}', 'エージェントウィンドウを取得できません：{detail}'],
  agentClosed: ['该智能体窗口已关闭', '該智慧代理視窗已關閉', 'That agent window has closed', 'このエージェントウィンドウは閉じられました'],
  sessionClosed: ['该会话已不在运行。', '該工作階段已停止執行。', 'That session is no longer running.', 'このセッションは終了しています。'],
  terminalTimeout: ['打开终端超时。', '開啟終端機逾時。', 'Opening the terminal timed out.', 'ターミナルを開く処理がタイムアウトしました。'],
  terminalFailed: ['终端启动失败：{detail}', '終端機啟動失敗：{detail}', 'Terminal launch failed: {detail}', 'ターミナルを起動できません：{detail}'],
  unsupportedTerminal: ['当前系统不支持首选终端“{terminal}”，请在设置中重新选择。', '目前系統不支援偏好終端機「{terminal}」，請在設定中重新選擇。', 'The preferred terminal “{terminal}” is unsupported on this system. Choose another in Settings.', 'このシステムは優先ターミナル「{terminal}」に対応していません。設定で選び直してください。'],
  cwdUnavailable: ['无法读取该会话的工作目录。', '無法讀取該工作階段的工作目錄。', 'Could not read the session working directory.', 'セッションの作業ディレクトリを取得できません。'],
  cwdInvalid: ['会话工作目录不是有效的绝对路径。', '工作階段的工作目錄不是有效的絕對路徑。', 'The session working directory is not a valid absolute path.', 'セッションの作業ディレクトリが有効な絶対パスではありません。'],
  desktopUnavailable: ['当前会话没有图形桌面，无法打开终端窗口。', '目前工作階段沒有圖形桌面，無法開啟終端機視窗。', 'This session has no graphical desktop for a terminal window.', 'このセッションにはターミナルを開くためのグラフィカルデスクトップがありません。'],
  terminalMissing: ['未找到终端“{terminal}”。请安装该终端或在设置中选择其他终端。', '找不到終端機「{terminal}」。請安裝該終端機或在設定中選擇其他終端機。', 'Terminal “{terminal}” was not found. Install it or choose another in Settings.', 'ターミナル「{terminal}」が見つかりません。インストールするか、設定で別のものを選んでください。'],
  noWritableWindow: ['该会话没有可写入的窗口', '該工作階段沒有可寫入的視窗', 'This session has no window that can receive input', 'このセッションには入力できるウィンドウがありません'],
  sharedWindow: ['该窗口内有 {count} 个受监控会话，输入会送到其中当前获得焦点的那个，无法确定是你选的那个，因此不允许写入。', '該視窗內有 {count} 個受監控工作階段，輸入會送到目前取得焦點的工作階段，無法確定是否為你選取的工作階段，因此不允許寫入。', 'This window contains {count} monitored sessions. Input would go to the focused session, which may differ from the selected session, so typing is unavailable.', 'このウィンドウには監視中のセッションが {count} 個あります。入力先はフォーカス中のセッションとなり、選択したセッションか確認できないため入力できません。'],
  captureUnavailable: ['当前应用无法截取窗口。', '目前應用程式無法擷取視窗。', 'This app cannot capture windows.', 'このアプリではウィンドウをキャプチャできません。'],
  captureFailed: ['窗口截取失败：{detail}', '視窗擷取失敗：{detail}', 'Window capture failed: {detail}', 'ウィンドウをキャプチャできません：{detail}'],
  windowTypeUnavailable: ['当前应用未提供窗口输入功能。', '目前應用程式未提供視窗輸入功能。', 'This app cannot type into windows.', 'このアプリではウィンドウに入力できません。'],
  windowTextMissing: ['请输入要发送的文本。', '請輸入要傳送的文字。', 'Enter the text to send.', '送信するテキストを入力してください。'],
} satisfies Record<string, readonly [string, string, string, string]>;

export type NativeMessageKey = keyof typeof messages;

export function nativeMessage(locale: DesktopLocale, key: NativeMessageKey, parameters: Readonly<Record<string, string | number>> = {}): string {
  const text = messages[key][DESKTOP_LOCALES.indexOf(locale)];
  return text.replace(/\{(\w+)\}/gu, (placeholder, name: string) => String(parameters[name] ?? placeholder));
}
