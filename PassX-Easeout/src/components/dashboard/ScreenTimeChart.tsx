import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Text, Dimensions, ActivityIndicator, TouchableOpacity } from 'react-native';
import { BarChart } from 'react-native-chart-kit';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { firestore } from '../../services/firebase';
import colors from '../../constants/colors';

const screenWidth = Dimensions.get('window').width;
const WEEK_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function getWeekDates() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
  // Shift so Monday = index 0
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().split('T')[0];
  });
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

// Track time the component is mounted (proxy for app screen time today)
let _sessionStartMs: number | null = null;

export default function ScreenTimeChart() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [data, setData] = useState<number[]>([0, 0, 0, 0, 0, 0, 0]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [todayMins, setTodayMins] = useState(0);

  const screenTimeRef = () => firestore().collection('users').doc(user!.uid).collection('screenTime');

  useEffect(() => {
    if (!user) return;
    _sessionStartMs = Date.now();

    const weekDates = getWeekDates();
    const todayKey = getTodayKey();

    // Listen to this week's data realtime
    const unsub = screenTimeRef()
      .where('date', 'in', weekDates)
      .onSnapshot(async (snap) => {
        const map: Record<string, number> = {};
        snap.docs.forEach((d) => { map[d.data().date] = d.data().hours || 0; });

        setData(weekDates.map((date) => parseFloat((map[date] || 0).toFixed(1))));
        setTodayMins(Math.round((map[todayKey] || 0) * 60));
        setLoading(false);
      }, () => setLoading(false));

    // On unmount: record time spent
    return () => {
      unsub();
      if (_sessionStartMs && user) {
        const elapsedHours = (Date.now() - _sessionStartMs) / 3600000;
        const todayKey2 = getTodayKey();
        screenTimeRef().doc(todayKey2).get().then((doc) => {
          const existing = doc.data()?.hours || 0;
          screenTimeRef().doc(todayKey2).set({
            date: todayKey2,
            hours: parseFloat((existing + elapsedHours).toFixed(2)),
          });
        });
        _sessionStartMs = null;
      }
    };
  }, [user]);

  // Manual setter for today's hours
  const setTodayHours = async (hrs: number) => {
    const todayKey = getTodayKey();
    await screenTimeRef().doc(todayKey).set({ date: todayKey, hours: hrs });
    setEditing(false);
  };

  if (loading) {
    return (
      <View style={[styles.card, { backgroundColor: theme.card }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: theme.card }]}>
      <View style={styles.headerRow}>
        <Text style={[styles.chartHeader, { color: theme.textSub }]}>Daily Usage (Hrs)</Text>
        <TouchableOpacity onPress={() => setEditing(!editing)}>
          <Text style={{ color: colors.primary, fontSize: 12, fontWeight: '600' }}>
            {editing ? 'Cancel' : 'Edit Today'}
          </Text>
        </TouchableOpacity>
      </View>

      <BarChart
        data={{
          labels: WEEK_LABELS,
          datasets: [{ data: data.length === 7 ? data : [0, 0, 0, 0, 0, 0, 0] }],
        }}
        width={screenWidth - 70}
        height={180}
        yAxisLabel=""
        yAxisSuffix="h"
        chartConfig={{
          backgroundColor: theme.card,
          backgroundGradientFrom: theme.card,
          backgroundGradientTo: theme.card,
          decimalPlaces: 1,
          color: (opacity = 1) => `rgba(36, 182, 184, ${opacity})`,
          labelColor: () => theme.textSub,
          barPercentage: 0.55,
          propsForBackgroundLines: { stroke: theme.border, strokeWidth: 1 },
        }}
        style={{ borderRadius: 12 }}
        showValuesOnTopOfBars
      />

      {editing && (
        <View style={styles.editRow}>
          <Text style={[styles.editLabel, { color: theme.textMain }]}>Today's hours:</Text>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((h) => (
            <TouchableOpacity key={h} style={[styles.chip, { borderColor: theme.border }]} onPress={() => setTodayHours(h)}>
              <Text style={{ color: theme.textMain, fontWeight: '600', fontSize: 13 }}>{h}h</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20, padding: 15,
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 3,
    alignItems: 'center',
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginBottom: 8, paddingHorizontal: 5 },
  chartHeader: { fontWeight: '600', fontSize: 13 },
  editRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12, alignItems: 'center' },
  editLabel: { fontSize: 13, fontWeight: '600', marginRight: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1 },
});