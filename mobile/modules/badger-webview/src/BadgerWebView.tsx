import { requireNativeView } from 'expo';
import * as React from 'react';

import type { BadgerWebViewProps, BadgerWebViewRef } from './BadgerWebView.types';

// The view's AsyncFunctions sit on the native component's instance, so its ref is a BadgerWebViewRef.
const NativeView = requireNativeView<BadgerWebViewProps & React.RefAttributes<BadgerWebViewRef>>('BadgerWebView');

export default React.forwardRef<BadgerWebViewRef, BadgerWebViewProps>(function BadgerWebView(props, ref) {
  return <NativeView {...props} ref={ref} />;
});
