import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import colors from '../constants/colors';

type RouteName = 'Dashboard' | 'Calendar' | 'Projects' | 'Account' | 'CustomSpaces' | 'Goals' | 'Profiles' | 'PasswordManager' | 'StudyPlan' | 'JobTracker';


interface BottomNavProps {
  navigation: any;
  activeRoute: RouteName;
}

const NAV_ITEMS = [
  { icon: 'home-outline',           activeIcon: 'home',              label: 'Home',      route: 'Dashboard'  },
  { icon: 'calendar-outline',       activeIcon: 'calendar',          label: 'Calendar',  route: 'Calendar'   },
  { icon: 'folder-open-outline',    activeIcon: 'folder-open',       label: 'Projects',  route: 'Projects'   },
  { icon: 'person-outline',         activeIcon: 'person',            label: 'Profile',   route: 'Account'    },
] as const;

export default function BottomNav({ navigation, activeRoute }: BottomNavProps) {
  const { theme } = useTheme();

  return (
    <View style={[styles.wrapper, { backgroundColor: theme.navBg }]}>
      {NAV_ITEMS.slice(0, 2).map((item) => {
        const isActive = activeRoute === item.route;
        return (
          <TouchableOpacity
            key={item.route}
            style={styles.navItem}
            onPress={() => navigation.navigate(item.route)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={(isActive ? item.activeIcon : item.icon) as any}
              size={24}
              color={isActive ? colors.primary : theme.textSub}
            />
            <Text style={[styles.navText, { color: isActive ? colors.primary : theme.textSub }]}>
              {item.label}
            </Text>
          </TouchableOpacity>
        );
      })}

      {/* FAB in the middle */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('CustomSpaces')}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={32} color="white" />
      </TouchableOpacity>

      {NAV_ITEMS.slice(2).map((item) => {
        const isActive = activeRoute === item.route;
        return (
          <TouchableOpacity
            key={item.route}
            style={styles.navItem}
            onPress={() => navigation.navigate(item.route)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={(isActive ? item.activeIcon : item.icon) as any}
              size={24}
              color={isActive ? colors.primary : theme.textSub}
            />
            <Text style={[styles.navText, { color: isActive ? colors.primary : theme.textSub }]}>
              {item.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    borderRadius: 25,
    height: 70,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 12,
    paddingHorizontal: 5,
  },
  navItem: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    top: 5,
  },
  navText: {
    fontSize: 10,
    marginTop: 4,
  },
  fab: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: -35,
    shadowColor: colors.primary,
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
    borderWidth: 4,
    borderColor: '#F8F9FA',
  },
});
