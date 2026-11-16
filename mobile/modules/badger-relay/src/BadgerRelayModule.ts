import { NativeModule, requireNativeModule } from 'expo';

declare class BadgerRelayModule extends NativeModule<{}> {
  setValueAsync(value: string): Promise<void>;
}

export default requireNativeModule<BadgerRelayModule>('BadgerRelay');
