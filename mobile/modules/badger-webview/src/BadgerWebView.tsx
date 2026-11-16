import { requireNativeView } from 'expo';
import * as React from 'react';

import { BadgerWebViewProps } from './BadgerWebView.types';

const NativeView: React.ComponentType<BadgerWebViewProps> = requireNativeView('BadgerWebView');

export default function BadgerWebView(props: BadgerWebViewProps) {
  return <NativeView {...props} />;
}
