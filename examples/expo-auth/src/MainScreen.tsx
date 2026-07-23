import React, { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { ChatScreen } from "./ChatScreen"
import { HomeScreen } from "./HomeScreen"
import { useProfileDisplayName } from "./useProfileDisplayName"

type Tab = "profile" | "chat"

const TABS: { id: Tab; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "chat", label: "Chat" },
]

export function MainScreen(): React.ReactElement {
  const [tab, setTab] = useState<Tab>("chat")
  const profileState = useProfileDisplayName()

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        <View style={[styles.panel, tab !== "profile" && styles.hidden]}>
          <HomeScreen profileState={profileState} />
        </View>
        <View style={[styles.panel, tab !== "chat" && styles.hidden]}>
          <ChatScreen
            authorName={profileState.displayName}
            currentUserId={profileState.userId}
          />
        </View>
      </View>
      <View style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setTab(t.id)}
            style={[styles.tab, tab === t.id ? styles.tabActive : null]}
          >
            <Text style={[styles.tabText, tab === t.id ? styles.tabTextActive : null]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  content: {
    flex: 1,
  },
  panel: {
    flex: 1,
  },
  hidden: {
    display: "none",
  },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e7eb",
    paddingBottom: 8,
    paddingTop: 4,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
  },
  tabActive: {
    borderTopWidth: 2,
    borderTopColor: "#0f766e",
  },
  tabText: {
    fontSize: 14,
    color: "#6b7280",
    fontWeight: "500",
  },
  tabTextActive: {
    color: "#0f766e",
    fontWeight: "700",
  },
})
