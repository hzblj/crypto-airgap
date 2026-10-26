import {Tabs} from '@hzblj/kara-ui/router'

export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen icon="key" name="(signer)" selectedIcon="key" title="Signer" />
      <Tabs.Screen icon="visibility" name="watch" selectedIcon="visibility" title="Watch-only" />
      <Tabs.Screen icon="replay" name="loopback" selectedIcon="replay" title="Loopback" />
    </Tabs>
  )
}
