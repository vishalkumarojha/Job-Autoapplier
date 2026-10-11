import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, Alert,
  Modal, TextInput, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { firestore } from '../../services/firebase';
import colors from '../../constants/colors';
import BackHeader from '../../components/BackHeader';
import BottomNav from '../../components/BottomNav';

const SPACE_COLORS = ['#FF6B6B', '#4ECDC4', '#F4A261', '#A29BFE', '#55EFC4', '#FDCB6E'];

interface Task {
  id: string;
  title: string;
  deadline: string;
  isCompleted: boolean;
}

interface Space {
  id: string;
  name: string;
  color: string;
}

export default function CustomSpacesScreen({ navigation }: any) {
  const { user } = useAuth();
  const { theme } = useTheme();

  const [spaces, setSpaces] = useState<Space[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [loadingSpaces, setLoadingSpaces] = useState(true);
  const [loadingTasks, setLoadingTasks] = useState(false);

  const [isTaskModalVisible, setTaskModalVisible] = useState(false);
  const [isSpaceModalVisible, setSpaceModalVisible] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDeadline, setNewTaskDeadline] = useState('');
  const [newSpaceName, setNewSpaceName] = useState('');
  const [saving, setSaving] = useState(false);

  const spacesRef = () => firestore().collection('users').doc(user!.uid).collection('spaces');
  const tasksRef = (sid: string) => spacesRef().doc(sid).collection('tasks');

  // Load spaces
  useEffect(() => {
    if (!user) return;
    const unsub = spacesRef()
      .orderBy('createdAt', 'asc')
      .onSnapshot((snap) => {
        const data = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Space));
        setSpaces(data);
        if (!activeSpaceId && data.length > 0) setActiveSpaceId(data[0].id);
        setLoadingSpaces(false);
      }, () => setLoadingSpaces(false));
    return unsub;
  }, [user]);

  // Load tasks for active space
  useEffect(() => {
    if (!activeSpaceId || !user) return;
    setLoadingTasks(true);
    const unsub = tasksRef(activeSpaceId)
      .orderBy('createdAt', 'asc')
      .onSnapshot((snap) => {
        setTasks(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Task)));
        setLoadingTasks(false);
      }, () => setLoadingTasks(false));
    return unsub;
  }, [activeSpaceId, user]);

  const handleAddSpace = async () => {
    if (!newSpaceName.trim()) {
      Alert.alert('Missing Field', 'Please enter a workspace name.');
      return;
    }
    setSaving(true);
    try {
      const color = SPACE_COLORS[spaces.length % SPACE_COLORS.length];
      const ref = await spacesRef().add({
        name: newSpaceName, color,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      setActiveSpaceId(ref.id);
      setSpaceModalVisible(false);
      setNewSpaceName('');
    } finally {
      setSaving(false);
    }
  };

  const handleAddTask = async () => {
    if (!newTaskTitle.trim()) {
      Alert.alert('Missing Field', 'Please enter a task name.');
      return;
    }
    if (!activeSpaceId) return;
    setSaving(true);
    try {
      await tasksRef(activeSpaceId).add({
        title: newTaskTitle,
        deadline: newTaskDeadline,
        isCompleted: false,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      setTaskModalVisible(false);
      setNewTaskTitle(''); setNewTaskDeadline('');
    } finally {
      setSaving(false);
    }
  };

  const toggleTask = async (taskId: string, current: boolean) => {
    if (!activeSpaceId) return;
    await tasksRef(activeSpaceId).doc(taskId).update({ isCompleted: !current });
  };

  const deleteTask = async (taskId: string) => {
    if (!activeSpaceId) return;
    await tasksRef(activeSpaceId).doc(taskId).delete();
  };

  const activeSpace = spaces.find((s) => s.id === activeSpaceId);
  const pendingCount = tasks.filter((t) => !t.isCompleted).length;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <BackHeader title="My Workspaces" navigation={navigation} />

      {/* Space Tabs */}
      <View style={styles.tabContainer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabScroll}>
          {loadingSpaces ? (
            <ActivityIndicator color={colors.primary} size="small" />
          ) : (
            <>
              {spaces.map((space) => {
                const isActive = activeSpaceId === space.id;
                return (
                  <TouchableOpacity
                    key={space.id}
                    style={[styles.tab, isActive && { backgroundColor: space.color, borderColor: space.color }]}
                    onPress={() => setActiveSpaceId(space.id)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.tabText, { color: isActive ? 'white' : theme.textMain }]}>{space.name}</Text>
                    {isActive && (
                      <View style={styles.countBadge}>
                        <Text style={styles.countText}>{pendingCount}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity style={[styles.addTab, { borderColor: theme.textSub }]} onPress={() => setSpaceModalVisible(true)}>
                <Ionicons name="add" size={20} color={theme.textSub} />
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </View>

      {/* Task list */}
      <View style={styles.contentArea}>
        {spaces.length === 0 ? (
          <View style={styles.emptyCenter}>
            <Ionicons name="albums-outline" size={60} color={theme.border} />
            <Text style={[styles.emptyTitle, { color: theme.textSub }]}>No workspaces yet.</Text>
            <Text style={[styles.emptySub, { color: theme.textSub }]}>Tap + to create your first space.</Text>
          </View>
        ) : (
          <>
            <View style={styles.listHeaderRow}>
              <Text style={[styles.sectionTitle, { color: theme.textMain }]}>{activeSpace?.name} Tasks</Text>
              <TouchableOpacity onPress={() => setTaskModalVisible(true)}>
                <Ionicons name="add-circle" size={32} color={activeSpace?.color || colors.primary} />
              </TouchableOpacity>
            </View>
            {loadingTasks ? (
              <ActivityIndicator color={colors.primary} />
            ) : (
              <FlatList
                data={tasks}
                keyExtractor={(item) => item.id}
                contentContainerStyle={{ paddingBottom: 100 }}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                  <View style={styles.emptyCenter}>
                    <Ionicons name="file-tray-outline" size={48} color={theme.border} />
                    <Text style={[styles.emptySub, { color: theme.textSub }]}>No tasks yet. Tap + to add one.</Text>
                  </View>
                }
                renderItem={({ item }) => (
                  <View style={[styles.taskCard, { backgroundColor: theme.card }, item.isCompleted && styles.taskCardCompleted]}>
                    <TouchableOpacity
                      style={[styles.checkbox, { borderColor: item.isCompleted ? '#DDD' : activeSpace?.color || colors.primary }, item.isCompleted && styles.checkboxDone]}
                      onPress={() => toggleTask(item.id, item.isCompleted)}
                    >
                      {item.isCompleted && <Ionicons name="checkmark" size={14} color="white" />}
                    </TouchableOpacity>
                    <View style={styles.taskInfo}>
                      <Text style={[styles.taskTitle, { color: theme.textMain }, item.isCompleted && styles.textCompleted]}>{item.title}</Text>
                      {item.deadline ? (
                        <View style={styles.deadlineRow}>
                          <Ionicons name="time-outline" size={12} color={theme.textSub} />
                          <Text style={[styles.taskDeadline, { color: theme.textSub }]}>{item.deadline}</Text>
                        </View>
                      ) : null}
                    </View>
                    <TouchableOpacity onPress={() => deleteTask(item.id)} style={{ padding: 6 }}>
                      <Ionicons name="close-circle-outline" size={20} color={theme.textSub} />
                    </TouchableOpacity>
                  </View>
                )}
              />
            )}
          </>
        )}
      </View>

      {/* Add Task Modal */}
      <Modal visible={isTaskModalVisible} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textMain }]}>New Task</Text>
              <TouchableOpacity onPress={() => setTaskModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSub} />
              </TouchableOpacity>
            </View>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="What do you need to do?" placeholderTextColor={theme.textSub} value={newTaskTitle} onChangeText={setNewTaskTitle} autoFocus />
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Deadline (e.g. Tomorrow)" placeholderTextColor={theme.textSub} value={newTaskDeadline} onChangeText={setNewTaskDeadline} />
            <TouchableOpacity style={[styles.saveBtn, { backgroundColor: activeSpace?.color || colors.primary }]} onPress={handleAddTask} disabled={saving}>
              {saving ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.saveText}>Add Task</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add Space Modal */}
      <Modal visible={isSpaceModalVisible} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.card }]}>
            <Text style={[styles.modalTitle, { color: theme.textMain }]}>Create Workspace</Text>
            <Text style={[styles.modalSub, { color: theme.textSub }]}>Give your new space a name (e.g., "Fitness", "Project X")</Text>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Space Name" placeholderTextColor={theme.textSub} value={newSpaceName} onChangeText={setNewSpaceName} />
            <View style={styles.modalActions}>
              <TouchableOpacity onPress={() => setSpaceModalVisible(false)} style={{ padding: 10 }}>
                <Text style={{ color: theme.textSub, fontWeight: '600' }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.saveBtnSmall, { backgroundColor: colors.primary }]} onPress={handleAddSpace} disabled={saving}>
                {saving ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.saveText}>Create</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      <BottomNav navigation={navigation} activeRoute="CustomSpaces" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12 },
  title: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { fontSize: 14, marginTop: 4 },
  tabContainer: { height: 60, marginBottom: 10 },
  tabScroll: { paddingHorizontal: 24, alignItems: 'center' },
  tab: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, paddingHorizontal: 17, borderRadius: 25, marginRight: 10, borderWidth: 1, borderColor: '#EEE', backgroundColor: 'white', elevation: 1 },
  tabText: { fontSize: 14, fontWeight: '600' },
  countBadge: { backgroundColor: 'rgba(255,255,255,0.25)', marginLeft: 7, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 },
  countText: { color: 'white', fontSize: 10, fontWeight: 'bold' },
  addTab: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', borderStyle: 'dashed', borderWidth: 1 },
  contentArea: { flex: 1, paddingHorizontal: 24 },
  emptyCenter: { alignItems: 'center', marginTop: 60, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', marginTop: 15 },
  emptySub: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  listHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold' },
  taskCard: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, padding: 16, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 8 },
  taskCardCompleted: { opacity: 0.6 },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  checkboxDone: { backgroundColor: '#CCC', borderColor: '#CCC' },
  taskInfo: { flex: 1 },
  taskTitle: { fontSize: 15, fontWeight: '600' },
  textCompleted: { textDecorationLine: 'line-through', opacity: 0.6 },
  deadlineRow: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
  taskDeadline: { fontSize: 12, marginLeft: 4, fontWeight: '500' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, paddingBottom: 50 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  modalTitle: { fontSize: 22, fontWeight: 'bold' },
  modalSub: { fontSize: 14, marginBottom: 16 },
  input: { borderRadius: 12, padding: 15, marginBottom: 14, fontSize: 15 },
  saveBtn: { paddingVertical: 15, borderRadius: 14, alignItems: 'center', marginTop: 8 },
  saveBtnSmall: { paddingVertical: 11, paddingHorizontal: 22, borderRadius: 12 },
  saveText: { color: 'white', fontWeight: 'bold', fontSize: 15 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 8 },
});