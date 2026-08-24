/* ============================================================
 * state —— 中央状态 + 订阅通知（依赖 config 的 ROT_ORDER）
 * 数据流：api 层写入 → notify → render 层各自重绘
 * ============================================================ */

const state = {
  tasks: [],       // 原始任务数组（来自 /api/tasks）
  projects: [],    // 项目数组（来自 /api/projects）
  online: true,    // 服务是否可达
  seq: [],         // 轮转序列（已排序、剔除完成/取消）
  idx: 0,          // 轮转当前位置
  view: null,      // 当前视图：'mini' | 'large'；null=未初始化（见 bridge.js 守卫注释）
  filter: 'all',   // large 列表筛选：'all' | 状态枚举
  largeView: 'list', // large 内部子视图：'list' | 'detail'（L3-本机详情+评论）
  detailId: null,  // 当前详情的任务 id
  detail: null,    // 当前详情数据（issue_detail 返回的 {task, comments, activities}）
};

const _listeners = new Set();

// 订阅数据变化，返回取消函数
function subscribe(fn){ _listeners.add(fn); return () => _listeners.delete(fn); }

function _notify(){ _listeners.forEach((fn) => { try{ fn(); }catch(e){ console.error(e); } }); }

// 写入数据并重算派生序列
function setData(tasks, projects, online){
  state.tasks = tasks;
  state.projects = projects;
  state.online = online;
  state.seq = tasks
    .filter((t) => t.status !== 'done' && t.status !== 'canceled')
    .sort((a, b) => (ROT_ORDER[a.status] - ROT_ORDER[b.status]) || ((a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1)));
  if (state.idx >= state.seq.length) state.idx = 0;
  _notify();
}

// 仅更新在线状态
function setOnline(online){
  state.online = online;
  _notify();
}

// 设置 large 列表筛选
function setFilter(f){
  state.filter = f;
  _notify();
}
