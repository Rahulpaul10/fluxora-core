import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Keeps one broken page from blanking the whole wallet: shows a recovery card instead. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[FLUXORA] page crashed:', error, info.componentStack)
  }

  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: undefined })
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="glass space-y-3 rounded-3xl p-6 text-center" role="alert">
        <h2 className="font-display text-xl font-semibold text-white">This page hit an error</h2>
        <p className="text-sm text-slate-400">Your funds and wallet connection are not affected. Reload the page to try again.</p>
        <p className="break-words font-mono text-xs text-slate-500">{this.state.error.message}</p>
        <button className="btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
