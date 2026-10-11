import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import colors from '../../constants/colors';
import BackHeader from '../../components/BackHeader';
import BottomNav from '../../components/BottomNav';
import { useTheme } from '../../context/ThemeContext';

export default function GoalsScreen({ navigation }: any) {
  const { theme } = useTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <BackHeader title="Goals (AI)" navigation={navigation} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.card, { backgroundColor: theme.card }]}>
          <Ionicons name="construct-outline" size={40} color={colors.primary} />
          <Text style={[styles.title, { color: theme.textMain }]}>AI goal breakdown is not available yet</Text>
          <Text style={[styles.body, { color: theme.textSub }]}>
            Goal planning previously called a third-party AI provider directly from the device
            using a key embedded in the app. That call path has been removed. AI features will
            return as a server-side integration, so no API credentials ship inside the app.
          </Text>
        </View>
      </ScrollView>
      <BottomNav navigation={navigation} activeRoute="Goals" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, padding: 20, justifyContent: 'center' },
  card: {
    borderRadius: 16, padding: 24, alignItems: 'center',
    elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8,
  },
  title: { fontSize: 17, fontWeight: 'bold', marginTop: 14, textAlign: 'center' },
  body: { fontSize: 14, marginTop: 10, textAlign: 'center', lineHeight: 21 },
});
