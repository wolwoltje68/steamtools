// Navigation shell. Everything behind the vault gate lives in a five-tab
// layout; the unlock screen replaces it entirely while the vault is locked.
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppProvider, useApp } from './src/state/AppContext.js';
import UnlockScreen from './src/screens/UnlockScreen.js';
import AccountsScreen from './src/screens/AccountsScreen.js';
import AddAccountScreen from './src/screens/AddAccountScreen.js';
import AccountDetailScreen from './src/screens/AccountDetailScreen.js';
import GuardScreen from './src/screens/GuardScreen.js';
import TradesScreen from './src/screens/TradesScreen.js';
import ConfirmationsScreen from './src/screens/ConfirmationsScreen.js';
import InventoryScreen from './src/screens/InventoryScreen.js';
import SendItemsScreen from './src/screens/SendItemsScreen.js';
import MarketSellScreen from './src/screens/MarketSellScreen.js';
import SettingsScreen from './src/screens/SettingsScreen.js';
import { colors } from './src/ui/theme.js';

const navigationTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.accent,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.accent,
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.text,
  headerTitleStyle: { fontWeight: '600' },
  contentStyle: { backgroundColor: colors.background },
};

const Tabs = createBottomTabNavigator();
const AccountsStack = createNativeStackNavigator();
const TradesStack = createNativeStackNavigator();
const InventoryStack = createNativeStackNavigator();

function AccountsNavigator() {
  return (
    <AccountsStack.Navigator screenOptions={screenOptions}>
      <AccountsStack.Screen name="AccountsList" component={AccountsScreen} options={{ title: 'Accounts' }} />
      <AccountsStack.Screen name="AddAccount" component={AddAccountScreen} options={{ title: 'Add account' }} />
      <AccountsStack.Screen name="AccountDetail" component={AccountDetailScreen} options={{ title: 'Account' }} />
    </AccountsStack.Navigator>
  );
}

function TradesNavigator() {
  return (
    <TradesStack.Navigator screenOptions={screenOptions}>
      <TradesStack.Screen name="TradesList" component={TradesScreen} options={{ title: 'Trade offers' }} />
    </TradesStack.Navigator>
  );
}

function InventoryNavigator() {
  return (
    <InventoryStack.Navigator screenOptions={screenOptions}>
      <InventoryStack.Screen name="InventoryList" component={InventoryScreen} options={{ title: 'Inventory' }} />
      <InventoryStack.Screen name="SendItems" component={SendItemsScreen} options={{ title: 'Send items' }} />
      <InventoryStack.Screen name="MarketSell" component={MarketSellScreen} options={{ title: 'Sell on market' }} />
    </InventoryStack.Navigator>
  );
}

/** Emoji tab icons keep the bundle free of an icon font dependency. */
function tabIcon(glyph) {
  return function TabIcon({ focused }) {
    return <Text style={[styles.tabIcon, focused && styles.tabIconActive]}>{glyph}</Text>;
  };
}

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={{
        ...screenOptions,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="Accounts"
        component={AccountsNavigator}
        options={{ headerShown: false, tabBarIcon: tabIcon('👤') }}
      />
      <Tabs.Screen
        name="Guard"
        component={GuardScreen}
        options={{ title: 'Steam Guard', tabBarIcon: tabIcon('🔐') }}
      />
      <Tabs.Screen
        name="Trades"
        component={TradesNavigator}
        options={{ headerShown: false, tabBarIcon: tabIcon('🔄') }}
      />
      <Tabs.Screen
        name="Confirm"
        component={ConfirmationsScreen}
        options={{ title: 'Confirmations', tabBarIcon: tabIcon('✅') }}
      />
      <Tabs.Screen
        name="Inventory"
        component={InventoryNavigator}
        options={{ headerShown: false, tabBarIcon: tabIcon('🎒') }}
      />
      <Tabs.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'Settings', tabBarIcon: tabIcon('⚙') }}
      />
    </Tabs.Navigator>
  );
}

function Root() {
  const { status } = useApp();

  if (status === 'loading') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  if (status === 'setup' || status === 'locked') return <UnlockScreen />;

  return (
    <NavigationContainer theme={navigationTheme}>
      <MainTabs />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppProvider>
        <Root />
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  tabIcon: { fontSize: 18, opacity: 0.55 },
  tabIconActive: { opacity: 1 },
});
