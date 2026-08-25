import { widgetConfig } from './vite.config.shared';

// mini 通道（先构建，清空 dist）：产物 dist/mini.html
export default widgetConfig('mini', true);
