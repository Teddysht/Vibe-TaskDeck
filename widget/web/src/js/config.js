/* ============================================================
 * config —— 常量与通用工具（无依赖，最先加载）
 * ============================================================ */

// 两级窗口尺寸（与 Tauri main.rs 的窗口尺寸保持一致）
const SIZES = { mini:{w:280,h:48}, large:{w:360,h:520} };

// 写操作归属的稳定会话标识由 Rust 数据层固定为 'taskboard-widget'（db.rs）

// 轮转与轮询节奏
const ROTATE_MS = 5000;    // mini 胶囊轮转间隔
const RETRY_MS = 5000;     // 离线重试间隔
const POLL_OK_MS = 5000;   // 在线时后台轮询兜底间隔（纯客户端读本地库开销极小，也是感知外部写入的唯一机制）

// 状态枚举（与上游 shared/domain.mjs 保持一致）
const STATUS_ORDER = ['backlog','todo','in_progress','in_review','blocked','done'];
const STATUS_LABEL = {
  backlog:'待办池', todo:'待处理', in_progress:'进行中',
  in_review:'待评审', blocked:'阻塞', done:'已完成', canceled:'已取消',
};

// 轮转优先级排序键（越小越优先展示）
const ROT_ORDER = { blocked:0, todo:1, in_review:2, in_progress:3, backlog:4, done:5, canceled:6 };

// 优先级
const PRI_LABEL = { urgent:'紧急', high:'高', medium:'中', low:'低', none:'' };

// 状态 → 形状类（progress=强调实心 / blocked=红实心 / done=绿实心 / review=描边 / idle=空心 / canceled=横线）
function shapeClass(s){
  return s==='in_progress'?'progress'
    : s==='blocked'?'blocked'
    : s==='done'?'done'
    : s==='in_review'?'review'
    : s==='canceled'?'canceled'
    : 'idle';
}

// 是否展示优先级徽标（仅紧急/高显示，中低静默）
function priBadge(p){
  return (p==='urgent'||p==='high') ? p : null;
}

// 日期裁剪为 YYYY-MM-DD
function shortDate(d){ return d ? d.slice(0,10) : ''; }

// 今天（YYYY-MM-DD，ISO 字符串可直接比较）；用于逾期判断。
// 每次调用重算而非模块加载时固化——挂件常驻跨天后逾期判定才会翻转。
function today(){ return new Date().toISOString().slice(0,10); }
function isOverdue(d){ return !!d && d < today(); }

// ISO 时间 → "MM-DD HH:mm"（评论/详情的时间展示；同日只显 HH:mm）
function shortTime(iso){
  if (!iso || iso.length < 16) return '';
  const now = new Date();
  const sameDay = iso.slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? iso.slice(11, 16) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

// HTML 转义（详情标题/描述/评论体来自数据库，渲染前必须转义）
function esc(s){
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function byId(id){ return document.getElementById(id); }

// 通用 toast（挂件内 3 秒自动消失；error=true 时用警示色）
function showToast(message, error){
  let el = document.getElementById('toast');
  if (!el){
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('error', !!error);
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 3000);
}
