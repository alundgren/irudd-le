import { mountUploadUi } from './index.js';

const root = document.getElementById('app');
if (!root) throw new Error('[upload-ui] missing #app');
mountUploadUi(root);
