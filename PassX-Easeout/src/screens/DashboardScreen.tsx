import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Image,
  TouchableOpacity, Platform, StatusBar, Modal, TextInput,
  FlatList, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { firestore } from '../services/firebase';
import colors from '../constants/colors';
import ScreenTimeChart from '../components/dashboard/ScreenTimeChart';
import QuickAccessGrid from '../components/dashboard/QuickAccessGrid';
import BottomNav from '../components/BottomNav';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Good night';
}

interface SearchResult {
  id: string;
  label: string;
  sub: string;
  icon: string;
  screen: string;
}

export default function DashboardScreen({ navigation }: any) {
  const { user, userProfile } = useAuth();
  const { theme } = useTheme();

  const [searchVisible, setSearchVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // ── Today's Priorities ───────────────────────────────────────────────────
  interface Priority {
    id: string;
    title: string;
    sub: string;
    icon: string;
    iconBg: string;
    iconColor: string;
    screen: string;
    isCompleted?: boolean;
  }
  const [priorities, setPriorities] = useState<Priority[]>([]);
  const [loadingPriorities, setLoadingPriorities] = useState(true);

  useEffect(() => {
    if (!user) return;
    const todayKey = new Date().toISOString().split('T')[0];
    const uid = user.uid;
    const hits: Priority[] = [];
    let done = 0;
    const tryDone = () => { done++; if (done === 2) { setPriorities(hits); setLoadingPriorities(false); } };

    // Today's uncompleted calendar tasks
    firestore()
      .collection('users').doc(uid)
      .collection('calendar').doc(todayKey)
      .collection('tasks')
      .where('isCompleted', '==', false)
      .limit(3)
      .get()
      .then((snap) => {
        const TYPE_COLOR: Record<string, { bg: string; color: string; icon: string }> = {
          job:      { bg: '#FFF0F0', color: '#FF6B6B', icon: 'briefcase' },
          study:    { bg: '#E0F7FA', color: '#4ECDC4', icon: 'book' },
          personal: { bg: '#FFF8E7', color: '#F4A261', icon: 'checkbox' },
        };
        snap.docs.forEach((d) => {
          const data = d.data();
          const style = TYPE_COLOR[data.type] || TYPE_COLOR.personal;
          hits.push({
            id: d.id,
            title: data.title,
            sub: `${data.time || 'All Day'} · Calendar`,
            icon: style.icon,
            iconBg: style.bg,
            iconColor: style.color,
            screen: 'Calendar',
          });
        });
        tryDone();
      }).catch(tryDone);

    // Pending job applications (Applied / Interview)
    firestore()
      .collection('users').doc(uid)
      .collection('jobs')
      .where('status', 'in', ['Applied', 'Interview'])
      .limit(2)
      .get()
      .then((snap) => {
        snap.docs.forEach((d) => {
          const data = d.data();
          hits.push({
            id: `job_${d.id}`,
            title: `${data.companyName} — ${data.role}`,
            sub: `Status: ${data.status} · Due: ${data.deadline || 'No deadline'}`,
            icon: 'briefcase-outline',
            iconBg: '#FFF0F0',
            iconColor: '#FF6B6B',
            screen: 'JobTracker',
          });
        });
        tryDone();
      }).catch(tryDone);
  }, [user]);

  // ── Header identity ──────────────────────────────────────────────────────────
  const displayName = userProfile?.displayName || user?.displayName || user?.email?.split('@')[0] || 'there';
  const photoURL = userProfile?.photoURL || user?.photoURL;

  const doSearch = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    setSearching(true);
    const uid = user!.uid;
    const qLower = q.toLowerCase();
    const hits: SearchResult[] = [];

    try {
      // Search passwords
      const pwSnap = await firestore().collection('users').doc(uid).collection('passwords').get();
      pwSnap.docs.forEach((d) => {
        const data = d.data();
        if (data.website?.toLowerCase().includes(qLower) || data.username?.toLowerCase().includes(qLower)) {
          hits.push({ id: d.id, label: data.website, sub: data.username || 'Password entry', icon: 'key-outline', screen: 'PasswordManager' });
        }
      });

      // Search projects
      const prjSnap = await firestore().collection('users').doc(uid).collection('projects').get();
      prjSnap.docs.forEach((d) => {
        const data = d.data();
        if (data.title?.toLowerCase().includes(qLower) || data.description?.toLowerCase().includes(qLower)) {
          hits.push({ id: d.id, label: data.title, sub: 'Project', icon: 'rocket-outline', screen: 'Projects' });
        }
      });

      // Search profiles
      const profSnap = await firestore().collection('users').doc(uid).collection('profiles').get();
      profSnap.docs.forEach((d) => {
        const data = d.data();
        if (data.platformName?.toLowerCase().includes(qLower) || data.accountName?.toLowerCase().includes(qLower)) {
          hits.push({ id: d.id, label: data.platformName, sub: data.accountName, icon: 'person-circle-outline', screen: 'Profiles' });
        }
      });

      // Search jobs
      const jobSnap = await firestore().collection('users').doc(uid).collection('jobs').get();
      jobSnap.docs.forEach((d) => {
        const data = d.data();
        if (data.companyName?.toLowerCase().includes(qLower) || data.role?.toLowerCase().includes(qLower)) {
          hits.push({ id: d.id, label: data.companyName, sub: data.role, icon: 'briefcase-outline', screen: 'JobTracker' });
        }
      });

      // Search study topics
      const studySnap = await firestore().collection('users').doc(uid).collection('studyTopics').get();
      studySnap.docs.forEach((d) => {
        const data = d.data();
        if (data.title?.toLowerCase().includes(qLower)) {
          hits.push({ id: d.id, label: data.title, sub: data.category || 'Study topic', icon: 'book-outline', screen: 'StudyPlan' });
        }
      });
    } catch {/* ignore */ }

    setResults(hits);
    setSearching(false);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      {/* HEADER */}
      <View style={styles.headerContainer}>
        <View style={styles.headerContent}>
          <View>
            <Text style={styles.greetingText}>{getGreeting()}, {displayName}!</Text>
            <Text style={styles.subGreetingText}>Ready to organize your life?</Text>
          </View>
          <TouchableOpacity onPress={() => navigation.navigate('Account')}>
            <Image
              source={photoURL ? { uri: photoURL } : { uri: 'https://i.pravatar.cc/150?img=12' }}
              style={styles.avatar}
            />
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.searchBar} onPress={() => setSearchVisible(true)} activeOpacity={0.8}>
          <Ionicons name="search-outline" size={20} color="#999" />
          <Text style={styles.searchText}>Search projects, passwords, or goals...</Text>
        </TouchableOpacity>
      </View>

      {/* SCROLLABLE CONTENT */}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 120 }} style={styles.scrollView}>
        <View style={styles.sectionContainer}>
          <Text style={[styles.sectionTitle, { color: theme.textMain }]}>Screen Time Analytics</Text>
          <ScreenTimeChart />
        </View>

        <View style={styles.sectionContainer}>
          <Text style={[styles.sectionTitle, { color: theme.textMain }]}>My Hub</Text>
          <QuickAccessGrid navigation={navigation} />
        </View>

        <View style={styles.sectionContainer}>
          <View style={styles.rowBetween}>
            <Text style={[styles.sectionTitle, { color: theme.textMain }]}>Today's Priorities</Text>
            <TouchableOpacity onPress={() => navigation.navigate('Calendar')}>
              <Text style={styles.seeAll}>See all</Text>
            </TouchableOpacity>
          </View>

          {loadingPriorities ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 10 }} />
          ) : priorities.length === 0 ? (
            <TouchableOpacity
              style={[styles.emptyPriority, { backgroundColor: theme.card }]}
              onPress={() => navigation.navigate('Calendar')}
              activeOpacity={0.8}
            >
              <Ionicons name="sunny-outline" size={28} color={colors.primary} />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <Text style={[styles.taskTitle, { color: theme.textMain }]}>You're all clear for today! 🎉</Text>
                <Text style={[styles.taskSub, { color: theme.textSub }]}>Tap to add tasks to your calendar.</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={theme.textSub} />
            </TouchableOpacity>
          ) : (
            priorities.map((item) => (
              <TouchableOpacity
                key={item.id}
                style={[styles.taskCard, { backgroundColor: theme.card }]}
                onPress={() => navigation.navigate(item.screen as any)}
              >
                <View style={[styles.iconBox, { backgroundColor: item.iconBg }]}>
                  <Ionicons name={item.icon as any} size={22} color={item.iconColor} />
                </View>
                <View style={styles.taskInfo}>
                  <Text style={[styles.taskTitle, { color: theme.textMain }]} numberOfLines={1}>{item.title}</Text>
                  <Text style={[styles.taskSub, { color: theme.textSub }]} numberOfLines={1}>{item.sub}</Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={theme.textSub} />
              </TouchableOpacity>
            ))
          )}
        </View>
      </ScrollView>

      {/* BOTTOM NAV */}
      <BottomNav navigation={navigation} activeRoute="Dashboard" />

      {/* SEARCH MODAL */}
      <Modal visible={searchVisible} animationType="slide" transparent>
        <View style={[styles.searchModalOverlay, { backgroundColor: theme.background }]}>
          <View style={[styles.searchBar2, { backgroundColor: theme.inputBg }]}>
            <Ionicons name="search-outline" size={20} color={theme.textSub} />
            <TextInput
              style={[styles.searchInput, { color: theme.textMain }]}
              placeholder="Search projects, passwords, goals..."
              placeholderTextColor={theme.textSub}
              value={query}
              onChangeText={doSearch}
              autoFocus
            />
            <TouchableOpacity onPress={() => { setSearchVisible(false); setQuery(''); setResults([]); }}>
              <Ionicons name="close-circle" size={22} color={theme.textSub} />
            </TouchableOpacity>
          </View>

          {searching ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id + item.screen}
              contentContainerStyle={{ paddingTop: 10, paddingBottom: 60 }}
              ListEmptyComponent={
                query.length >= 2 ? (
                  <Text style={[styles.noResults, { color: theme.textSub }]}>No results found for "{query}"</Text>
                ) : (
                  <Text style={[styles.noResults, { color: theme.textSub }]}>Start typing to search...</Text>
                )
              }
              renderItem={({ item }) => (
                <TouchableOpacity style={[styles.resultItem, { borderBottomColor: theme.border }]} onPress={() => { setSearchVisible(false); navigation.navigate(item.screen as any); }}>
                  <View style={[styles.resultIcon, { backgroundColor: theme.iconBg }]}>
                    <Ionicons name={item.icon as any} size={20} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.resultLabel, { color: theme.textMain }]}>{item.label}</Text>
                    <Text style={[styles.resultSub, { color: theme.textSub }]}>{item.sub}</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={16} color={theme.textSub} />
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  headerContainer: {
    backgroundColor: colors.primary,
    paddingTop: 20, paddingBottom: 30, paddingHorizontal: 20,
    borderBottomLeftRadius: 30, borderBottomRightRadius: 30, marginBottom: 10,
  },
  headerContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  greetingText: { color: 'rgba(255,255,255,0.85)', fontSize: 14 },
  subGreetingText: { color: 'white', fontSize: 20, fontWeight: 'bold', marginTop: 5 },
  avatar: { width: 50, height: 50, borderRadius: 25, borderWidth: 2, borderColor: 'white' },
  searchBar: {
    backgroundColor: 'white', borderRadius: 15, padding: 12,
    flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10, elevation: 4,
  },
  searchText: { marginLeft: 10, color: '#999', flex: 1 },
  scrollView: { flex: 1 },
  sectionContainer: { paddingHorizontal: 20, marginBottom: 25 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 15 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  seeAll: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  taskCard: { padding: 15, borderRadius: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 5 },
  emptyPriority: { padding: 16, borderRadius: 16, flexDirection: 'row', alignItems: 'center', marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 5 },
  iconBox: { width: 48, height: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 15 },
  taskInfo: { flex: 1 },
  taskTitle: { fontSize: 15, fontWeight: '600' },
  taskSub: { fontSize: 12, marginTop: 4 },
  // Search Modal
  searchModalOverlay: { flex: 1, paddingTop: 60, paddingHorizontal: 16 },
  searchBar2: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 16 },
  searchInput: { flex: 1, fontSize: 16, marginHorizontal: 10 },
  noResults: { textAlign: 'center', marginTop: 40, fontSize: 15 },
  resultItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 10, borderBottomWidth: 1 },
  resultIcon: { width: 40, height: 40, borderRadius: 10, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  resultLabel: { fontSize: 15, fontWeight: '600' },
  resultSub: { fontSize: 12, marginTop: 2 },
});