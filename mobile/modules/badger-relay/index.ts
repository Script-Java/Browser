// Re-export the native module. On web, it will be resolved to BadgerRelayModule.web.ts
// and on native platforms to BadgerRelayModule.ts
export { default } from './src/BadgerRelayModule';
export * from './src/BadgerRelay.types';
