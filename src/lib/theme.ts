import { createContext, useContext } from 'react'
import { ArrowDownToLine, ArrowLeftRight, ArrowUpRight, Landmark, LayoutDashboard, Receipt, ScrollText } from 'lucide-react'
import type { View } from './router'

/** Per-page color theme. The colors themselves live in index.css under [data-theme]. */
export interface ViewTheme {
  label: string
  icon: typeof ArrowUpRight
  /** CSS gradient for icon chips and nav highlights */
  gradient: string
  blurb: string
}

export const VIEW_THEMES: Record<View, ViewTheme> = {
  dashboard: { label: 'Dashboard', icon: LayoutDashboard, gradient: 'linear-gradient(135deg,#8257FF,#27D9FF)', blurb: 'Your whole wallet at a glance' },
  send: { label: 'Send', icon: ArrowUpRight, gradient: 'linear-gradient(135deg,#FF55B8,#8257FF)', blurb: 'Move money to any wallet' },
  receive: { label: 'Receive', icon: ArrowDownToLine, gradient: 'linear-gradient(135deg,#20D6A0,#27D9FF)', blurb: 'Share your address and get paid' },
  swap: { label: 'Swap', icon: ArrowLeftRight, gradient: 'linear-gradient(135deg,#27D9FF,#8257FF)', blurb: 'Trade at live pool prices' },
  bridge: { label: 'Bridge', icon: Landmark, gradient: 'linear-gradient(135deg,#8257FF,#20D6A0)', blurb: 'Move USDC across networks' },
  pay: { label: 'Pay', icon: Receipt, gradient: 'linear-gradient(135deg,#FF55B8,#FFB04D)', blurb: 'Request, collect and receipt payments' },
  history: { label: 'History', icon: ScrollText, gradient: 'linear-gradient(135deg,#8257FF,#FF55B8)', blurb: 'Everything that happened onchain' },
}

export const ViewContext = createContext<View>('dashboard')
export const useView = () => useContext(ViewContext)
