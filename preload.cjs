const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('compressorAPI', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectVideoFiles: () => ipcRenderer.invoke('select-video-files'),
  scanVideoFolder: () => ipcRenderer.invoke('select-video-folder'),
  scanVideoPaths: (paths) => ipcRenderer.invoke('scan-video-paths', paths),
  compressVideoBatch: (payload) => ipcRenderer.invoke('compress-video-batch', payload),
  appendVideoTasks: (jobId, files) => ipcRenderer.invoke('append-video-tasks', jobId, files),
  retryVideoTask: (jobId, taskId) => ipcRenderer.invoke('retry-video-task', jobId, taskId),
  cancelVideoCompress: (jobId) => ipcRenderer.invoke('cancel-video-compress', jobId),
  removeVideoTask: (jobId, taskId) => ipcRenderer.invoke('remove-video-task', jobId, taskId),
  pauseVideoCompress: (jobId) => ipcRenderer.invoke('pause-video-compress', jobId),
  resumeVideoCompress: (jobId) => ipcRenderer.invoke('resume-video-compress', jobId),
  onVideoProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('video-compress-progress', listener);
    return () => ipcRenderer.removeListener('video-compress-progress', listener);
  },
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectOutputFolder: () => ipcRenderer.invoke('select-output-folder'),
  scanPaths: (paths) => ipcRenderer.invoke('scan-paths', paths),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  compressBatch: (payload) => ipcRenderer.invoke('compress-batch', payload),
  cancelCompress: (jobId) => ipcRenderer.invoke('cancel-compress', jobId),
  onProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('compress-progress', listener);
    return () => ipcRenderer.removeListener('compress-progress', listener);
  },
});


