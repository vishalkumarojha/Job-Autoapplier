import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';

interface Props {
  title: string;
  navigation: any;
  rightElement?: React.ReactNode;
}

export default function BackHeader({ title, navigation, rightElement }: Props) {
  const { theme } = useTheme();
  return (
    <View style={[styles.header, { backgroundColor: theme.card, borderBottomColor: theme.border }]}>
      <TouchableOpacity
        style={styles.backBtn}
        onPress={() => navigation.goBack()}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="arrow-back" size={24} color={theme.textMain} />
      </TouchableOpacity>
      <Text style={[styles.title, { color: theme.textMain }]} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.right}>{rightElement || null}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 4,
  },
  backBtn: { padding: 4, marginRight: 12 },
  title: { flex: 1, fontSize: 18, fontWeight: '700' },
  right: { minWidth: 40, alignItems: 'flex-end' },
});
