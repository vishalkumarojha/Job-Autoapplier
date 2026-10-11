import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView,
  FlatList, TextInput, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { firestore } from '../../services/firebase';
import colors from '../../constants/colors';
import BackHeader from '../../components/BackHeader';
import BottomNav from '../../components/BottomNav';

interface RoadmapStep {
  id: string;
  title: string;
  isCompleted: boolean;
}

interface StudyTopic {
  id: string;
  title: string;
  category: string;
  completedSteps: number;
  totalSteps: number;
  roadmap: RoadmapStep[];
}

const DEFAULT_ROADMAP: Omit<RoadmapStep, 'id'>[] = [
  { title: 'Core Concepts & Definitions', isCompleted: false },
  { title: 'Intermediate Techniques', isCompleted: false },
  { title: 'Advanced Application', isCompleted: false },
  { title: 'Final Project / Review', isCompleted: false },
];

export default function StudyPlannerScreen({ navigation }: any) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [topics, setTopics] = useState<StudyTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTopic, setSelectedTopic] = useState<StudyTopic | null>(null);
  const [isAddModalVisible, setAddModalVisible] = useState(false);
  const [isExplainModalVisible, setExplainModalVisible] = useState(false);
  const [explanationText, setExplanationText] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [saving, setSaving] = useState(false);

  const topicsRef = () => firestore().collection('users').doc(user!.uid).collection('studyTopics');

  useEffect(() => {
    if (!user) return;
    const unsub = topicsRef()
      .orderBy('createdAt', 'desc')
      .onSnapshot((snap) => {
        setTopics(snap.docs.map((d) => ({ id: d.id, ...d.data() } as StudyTopic)));
        setLoading(false);
      }, () => setLoading(false));
    return unsub;
  }, [user]);

  const handleAddTopic = async () => {
    if (!newTitle.trim()) {
      Alert.alert('Missing Field', 'Please enter a topic name.');
      return;
    }
    setSaving(true);
    const roadmap = DEFAULT_ROADMAP.map((s, i) => ({ ...s, id: `step_${i}` }));
    try {
      await topicsRef().add({
        title: newTitle,
        category: newCategory || 'General',
        roadmap,
        completedSteps: 0,
        totalSteps: roadmap.length,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      setAddModalVisible(false);
      setNewTitle(''); setNewCategory('');
    } finally {
      setSaving(false);
    }
  };

  const toggleStep = async (topicId: string, stepId: string) => {
    const topic = topics.find((t) => t.id === topicId);
    if (!topic) return;
    const updated = topic.roadmap.map((s) =>
      s.id === stepId ? { ...s, isCompleted: !s.isCompleted } : s
    );
    const completedSteps = updated.filter((s) => s.isCompleted).length;
    await topicsRef().doc(topicId).update({ roadmap: updated, completedSteps });
    // Refresh selected topic view
    setSelectedTopic((prev) => prev?.id === topicId ? { ...prev, roadmap: updated, completedSteps } : prev);
  };

  const deleteTopic = async (id: string) => {
    Alert.alert('Delete Topic', 'Remove this study topic?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => topicsRef().doc(id).delete() },
    ]);
    setSelectedTopic(null);
  };

  const openExplanation = (title: string) => {
    setExplanationText(`Loading AI explanation for "${title}"...`);
    setExplainModalVisible(true);
    setTimeout(() => {
      setExplanationText(
        `Here is a simplified explanation of "${title}":\n\n` +
        `1. Core Concept — Understand the fundamental building blocks.\n` +
        `2. Why it matters — Critical for scalability and performance.\n` +
        `3. Key Takeaway — Master this to build robust, real-world systems.`
      );
    }, 1200);
  };

  const getProgress = (t: StudyTopic) => (t.totalSteps > 0 ? t.completedSteps / t.totalSteps : 0);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <BackHeader
        title="Study Planner"
        navigation={navigation}
        rightElement={
          <TouchableOpacity style={styles.addBtn} onPress={() => setAddModalVisible(true)}>
            <Ionicons name="add" size={22} color="white" />
          </TouchableOpacity>
        }
      />

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={topics}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="school-outline" size={60} color={theme.border} />
              <Text style={[styles.emptyTitle, { color: theme.textSub }]}>No study goals yet.</Text>
              <Text style={[styles.emptySub, { color: theme.textSub }]}>Tap + to add a topic and generate a roadmap.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const progress = getProgress(item);
            return (
              <TouchableOpacity style={[styles.card, { backgroundColor: theme.card }]} onPress={() => setSelectedTopic(item)} activeOpacity={0.9}>
                <View style={styles.cardHeader}>
                  <View style={styles.categoryChip}>
                    <Text style={styles.categoryText}>{item.category}</Text>
                  </View>
                  <TouchableOpacity style={styles.explainBtn} onPress={() => openExplanation(item.title)}>
                    <Ionicons name="sparkles" size={13} color="white" />
                    <Text style={styles.explainBtnText}>Explain</Text>
                  </TouchableOpacity>
                </View>
                <Text style={[styles.topicTitle, { color: theme.textMain }]}>{item.title}</Text>
                <View style={styles.progressRow}>
                  <View style={[styles.progressBg, { backgroundColor: theme.border }]}>
                    <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` as any }]} />
                  </View>
                  <Text style={[styles.progressText, { color: theme.textMain }]}>{Math.round(progress * 100)}%</Text>
                </View>
                <Text style={[styles.stepText, { color: theme.textSub }]}>{item.completedSteps} of {item.totalSteps} milestones completed</Text>
              </TouchableOpacity>
            );
          }}
        />
      )}

      {/* ADD MODAL */}
      <Modal visible={isAddModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textMain }]}>New Study Goal</Text>
              <TouchableOpacity onPress={() => setAddModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSub} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.label, { color: theme.textMain }]}>Topic Name *</Text>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="e.g. Advanced Python Patterns" placeholderTextColor={theme.textSub} value={newTitle} onChangeText={setNewTitle} />
            <Text style={[styles.label, { color: theme.textMain }]}>Category</Text>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="e.g. Coding, Design, Math" placeholderTextColor={theme.textSub} value={newCategory} onChangeText={setNewCategory} />
            <TouchableOpacity style={styles.saveBtn} onPress={handleAddTopic} disabled={saving}>
              {saving ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.saveText}>Create Roadmap</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ROADMAP MODAL */}
      <Modal visible={!!selectedTopic} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.card, height: '82%' }]}>
            {selectedTopic && (
              <>
                <View style={styles.modalHeader}>
                  <Text style={[styles.modalTitle, { flex: 1, color: theme.textMain }]}>{selectedTopic.title}</Text>
                  <TouchableOpacity onPress={() => deleteTopic(selectedTopic.id)} style={{ marginRight: 10 }}>
                    <Ionicons name="trash-outline" size={22} color="#E74C3C" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSelectedTopic(null)}>
                    <Ionicons name="close-circle" size={28} color={theme.textSub} />
                  </TouchableOpacity>
                </View>
                <Text style={[styles.sectionHeader, { color: theme.textMain }]}>Your Roadmap</Text>
                <ScrollView showsVerticalScrollIndicator={false}>
                  {selectedTopic.roadmap.map((step, i) => (
                    <TouchableOpacity key={step.id} style={styles.stepRow} onPress={() => toggleStep(selectedTopic.id, step.id)}>
                      <View style={[styles.checkbox, step.isCompleted && styles.checkboxChecked]}>
                        {step.isCompleted && <Ionicons name="checkmark" size={14} color="white" />}
                      </View>
                      <View style={styles.stepInfo}>
                        <Text style={[styles.stepTitle, { color: theme.textMain }, step.isCompleted && styles.stepDone]}>{step.title}</Text>
                        <Text style={[styles.stepSub, { color: theme.textSub }]}>Milestone {i + 1}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <TouchableOpacity style={styles.explainLargeBtn} onPress={() => { setSelectedTopic(null); openExplanation(selectedTopic.title); }}>
                  <Ionicons name="sparkles" size={18} color="white" />
                  <Text style={styles.explainLargeText}>Ask AI to Explain This Topic</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* AI MODAL */}
      <Modal visible={isExplainModalVisible} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.card }]}>
            <Text style={[styles.modalTitle, { color: theme.textMain }]}>AI Tutor</Text>
            <Text style={[styles.explanationText, { color: theme.textSub }]}>{explanationText}</Text>
            <TouchableOpacity style={[styles.closeBtn, { backgroundColor: theme.inputBg }]} onPress={() => setExplainModalVisible(false)}>
              <Text style={[styles.closeBtnText, { color: theme.textMain }]}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <BottomNav navigation={navigation} activeRoute="StudyPlan" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 20 },
  headerTitle: { fontSize: 28, fontWeight: 'bold' },
  headerSub: { fontSize: 14 },
  addBtn: { backgroundColor: colors.primary, width: 46, height: 46, borderRadius: 23, justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: colors.primary, shadowOpacity: 0.3, shadowRadius: 5 },
  emptyState: { alignItems: 'center', marginTop: 60, paddingHorizontal: 30 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', marginTop: 15 },
  emptySub: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  card: { borderRadius: 16, padding: 20, marginBottom: 15, elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  categoryChip: { backgroundColor: '#E8F6F3', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  categoryText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
  explainBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#9B59B6', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  explainBtnText: { color: 'white', fontSize: 11, fontWeight: 'bold', marginLeft: 4 },
  topicTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 14 },
  progressRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 7 },
  progressBg: { flex: 1, height: 8, borderRadius: 4, marginRight: 10 },
  progressFill: { height: 8, backgroundColor: colors.primary, borderRadius: 4 },
  progressText: { fontSize: 12, fontWeight: 'bold' },
  stepText: { fontSize: 12 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalCard: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 25 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  modalTitle: { fontSize: 20, fontWeight: 'bold' },
  sectionHeader: { fontSize: 17, fontWeight: 'bold', marginBottom: 14 },
  stepRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 18 },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: '#DDD', justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  stepInfo: { flex: 1 },
  stepTitle: { fontSize: 15, fontWeight: '600' },
  stepDone: { textDecorationLine: 'line-through', opacity: 0.5 },
  stepSub: { fontSize: 12, marginTop: 2 },
  explainLargeBtn: { backgroundColor: '#9B59B6', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', padding: 14, borderRadius: 14, marginTop: 16 },
  explainLargeText: { color: 'white', fontWeight: 'bold', fontSize: 15, marginLeft: 8 },
  label: { fontSize: 14, fontWeight: '600', marginBottom: 7, marginTop: 12 },
  input: { borderRadius: 12, padding: 14, fontSize: 15, borderWidth: 1, borderColor: 'transparent' },
  saveBtn: { backgroundColor: colors.primary, paddingVertical: 15, borderRadius: 14, alignItems: 'center', marginTop: 25 },
  saveText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  explanationText: { fontSize: 15, lineHeight: 24, marginBottom: 20, marginTop: 12 },
  closeBtn: { padding: 14, borderRadius: 12, alignItems: 'center' },
  closeBtnText: { fontWeight: 'bold' },
});