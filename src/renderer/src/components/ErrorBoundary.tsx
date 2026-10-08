import { Component, type ReactNode } from 'react';
import { useT } from '../i18n';
import { Button, Empty } from './ui';

function Fallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="page" role="alert">
      <Empty icon="alert" title={t('error.title')}>{t('error.hint')}</Empty>
      <p className="error small mono">{error.message}</p>
      <div><Button icon="replay" onClick={onRetry}>{t('error.retry')}</Button></div>
    </div>
  );
}

/**
 * Without a boundary one render error in any module unmounted the whole React tree and
 * left a blank window. Key it by the open page so navigating away recovers.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(error); }
  render() {
    return this.state.error ? <Fallback error={this.state.error} onRetry={() => this.setState({ error: null })} /> : this.props.children;
  }
}
