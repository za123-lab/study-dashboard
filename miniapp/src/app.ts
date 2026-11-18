import { PropsWithChildren } from 'react'
import { useLaunch } from '@tarojs/taro'
import { initA11y } from './data/a11y'

import './app.scss'

function App({ children }: PropsWithChildren<any>) {
  useLaunch(() => {
    initA11y()
  })

  // children 是将要会渲染的页面
  return children
}
  


export default App
