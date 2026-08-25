import { widgetConfig } from './vite.config.shared';

// fullboard 通道（第二趟构建，不清空 dist）：产物 dist/fullboard.html
export default widgetConfig('fullboard', false);
