// Re-export the native module. On web, it will be resolved to BadgerWebViewModule.web.ts
// and on native platforms to BadgerWebViewModule.ts
export { default } from './src/BadgerWebViewModule';
export { default as BadgerWebView } from './src/BadgerWebView';
export * from './src/BadgerWebView.types';
