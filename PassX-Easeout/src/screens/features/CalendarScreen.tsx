import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal,
  TextInput, FlatList, ActivityIndicator, Platform, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Calendar, DateData } from 'react-native-calendars';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { firestore } from '../../services/firebase';
import BottomNav from '../../components/BottomNav';
import colors from '../../constants/colors';

type TaskType = 'job' | 'study' | 'personal';

interface TaskItem {
  id: string;
  title: string;
  type: TaskType;
  time: string;
  isCompleted: boolean;
}

const TYPE_ICON: Record<TaskType, string> = { job: 'briefcase', study: 'book', personal: 'checkbox' };
const TYPE_COLOR: Record<TaskType, string> = { job: '#FF6B6B', study: '#4ECDC4', personal: '#F4A261' };

export default function CalendarScreen({ navigation }: any) {
  const { user } = useAuth();
  const { theme } = useTheme();

  const today = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState(today);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [markedDates, setMarkedDates] = useState<any>({});
  const [modalVisible, setModalVisible] = useState(false);
  const [newTask, setNewTask] = useState('');
  const [newTime, setNewTime] = useState('');
  const [newType, setNewType] = useState<TaskType>('personal');
  const [saving, setSaving] = useState(false);

  const tasksRef = () =>
    firestore().collection('users').doc(user!.uid).collection('calendar').doc(selectedDate).collection('tasks');

  // Load tasks for selected date
  useEffect(() => {
    if (!user) return;
    const unsub = tasksRef()
      .orderBy('createdAt', 'asc')
      .onSnapshot((snap) => {
        setTasks(snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskItem)));
      });
    return unsub;
  }, [user, selectedDate]);

  // Load all dates that have tasks (for calendar dots)
  useEffect(() => {
    if (!user) return;
    firestore().collection('users').doc(user.uid).collection('calendar')
      .get().then((snap) => {
        const marks: any = {};
        snap.docs.forEach((d) => { marks[d.id] = { marked: true, dotColor: 'white' }; });
        setMarkedDates(marks);
      });
  }, [user, tasks]);

  const getMarkedDatesWithSelected = () => {
    const result = { ...markedDates };
    result[selectedDate] = {
      ...result[selectedDate],
      selected: true,
      selectedColor: 'rgba(255,255,255,0.3)',
      selectedTextColor: 'white',
    };
    return result;
  };

  const addTask = async () => {
    if (!newTask) return;
    setSaving(true);
    try {
      await tasksRef().add({
        title: newTask,
        type: newType,
        time: newTime || 'All Day',
        isCompleted: false,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      setModalVisible(false);
      setNewTask(''); setNewTime(''); setNewType('personal');
    } finally {
      setSaving(false);
    }
  };

  const toggleComplete = async (task: TaskItem) => {
    await tasksRef().doc(task.id).update({ isCompleted: !task.isCompleted });
  };

  const deleteTask = async (id: string) => {
    await tasksRef().doc(id).delete();
  };

  const formatHeaderDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      {/* Calendar card */}
      <View style={styles.calendarCard}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headerTitle}>Schedule</Text>
            <Text style={styles.headerSubtitle}>Manage your timeline</Text>
          </View>
          <View style={styles.filterBtn}>
            <Ionicons name="filter" size={20} color={colors.primary} />
          </View>
        </View>

        <Calendar
          current={selectedDate}
          onDayPress={(day: DateData) => setSelectedDate(day.dateString)}
          markedDates={getMarkedDatesWithSelected()}
          theme={{
            backgroundColor: 'transparent',
            calendarBackground: 'transparent',
            textSectionTitleColor: 'rgba(255,255,255,0.7)',
            selectedDayBackgroundColor: 'rgba(255,255,255,0.2)',
            selectedDayTextColor: '#ffffff',
            todayTextColor: '#ffffff',
            dayTextColor: '#ffffff',
            textDisabledColor: 'rgba(255,255,255,0.25)',
            dotColor: '#ffffff',
            arrowColor: '#ffffff',
            monthTextColor: '#ffffff',
            textDayFontWeight: '600',
            textMonthFontWeight: 'bold',
            textDayFontSize: 14,
            textMonthFontSize: 18,
          }}
        />

        <View style={styles.statsRow}>
          <View style={styles.statChip}>
            <Ionicons name="alert-circle" size={15} color={colors.primary} />
            <Text style={styles.statText}>{tasks.length} Tasks</Text>
          </View>
          <View style={styles.statChip}>
            <Ionicons name="checkmark-circle" size={15} color="#2ECC71" />
            <Text style={styles.statText}>{tasks.filter((t) => t.isCompleted).length} Done</Text>
          </View>
        </View>
      </View>

      {/* Task list */}
      <View style={styles.listContainer}>
        <View style={styles.listHeader}>
          <Text style={[styles.listTitle, { color: theme.textMain }]}>Agenda for {formatHeaderDate(selectedDate)}</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setModalVisible(true)}>
            <Ionicons name="add" size={22} color="white" />
          </TouchableOpacity>
        </View>

        <FlatList
          data={tasks}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 110 }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="calendar-outline" size={48} color={theme.border} />
              <Text style={[styles.emptyText, { color: theme.textSub }]}>No plans for this day.</Text>
              <Text style={[styles.emptySub, { color: theme.textSub }]}>Tap + to add a task.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.taskCard, { backgroundColor: theme.card }]}>
              <TouchableOpacity
                style={[styles.iconBox, { backgroundColor: TYPE_COLOR[item.type] + '25' }]}
                onPress={() => toggleComplete(item)}
              >
                <Ionicons name={TYPE_ICON[item.type] as any} size={22} color={TYPE_COLOR[item.type]} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.taskInfo} onPress={() => toggleComplete(item)}>
                <Text style={[styles.taskTitle, { color: theme.textMain }, item.isCompleted && styles.completedText]}>
                  {item.title}
                </Text>
                <Text style={[styles.taskTime, { color: theme.textSub }]}>{item.time} • {item.type.toUpperCase()}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => deleteTask(item.id)} style={{ padding: 6 }}>
                {item.isCompleted
                  ? <Ionicons name="checkmark-circle" size={24} color="#2ECC71" />
                  : <Ionicons name="trash-outline" size={20} color={theme.textSub} />
                }
              </TouchableOpacity>
            </View>
          )}
        />
      </View>

      {/* Add task modal */}
      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.card }]}>
            <Text style={[styles.modalTitle, { color: theme.textMain }]}>Add to Schedule</Text>
            <TextInput
              style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]}
              placeholder="Task title"
              placeholderTextColor={theme.textSub}
              value={newTask}
              onChangeText={setNewTask}
            />
            <TextInput
              style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]}
              placeholder="Time (e.g. 2:00 PM)"
              placeholderTextColor={theme.textSub}
              value={newTime}
              onChangeText={setNewTime}
            />
            <Text style={[styles.typeLabel, { color: theme.textSub }]}>Type:</Text>
            <View style={styles.typeRow}>
              {(['job', 'study', 'personal'] as TaskType[]).map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.typeChip, { backgroundColor: newType === t ? TYPE_COLOR[t] : theme.border }]}
                  onPress={() => setNewType(t)}
                >
                  <Text style={{ color: newType === t ? 'white' : theme.textMain, fontWeight: '600', fontSize: 12 }}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.modalButtons}>
              <TouchableOpacity onPress={() => setModalVisible(false)} style={styles.cancelBtn}>
                <Text style={[styles.cancelText, { color: theme.textSub }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={addTask} style={styles.saveBtn} disabled={saving}>
                {saving ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.saveText}>Save Task</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <BottomNav navigation={navigation} activeRoute="Calendar" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  calendarCard: {
    backgroundColor: colors.primary,
    paddingTop: 20, paddingBottom: 20, paddingHorizontal: 20,
    borderBottomLeftRadius: 30, borderBottomRightRadius: 30,
    elevation: 8, shadowColor: colors.primary, shadowOpacity: 0.3, shadowRadius: 10, zIndex: 10,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  headerTitle: { fontSize: 28, fontWeight: 'bold', color: 'white' },
  headerSubtitle: { fontSize: 13, color: 'rgba(255,255,255,0.8)' },
  filterBtn: { backgroundColor: 'white', width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  statsRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  statChip: { flexDirection: 'row', backgroundColor: 'white', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, alignItems: 'center', elevation: 2, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 4 },
  statText: { marginLeft: 6, fontWeight: 'bold', color: colors.textDark, fontSize: 12 },
  listContainer: { flex: 1, paddingHorizontal: 20, marginTop: 20 },
  listHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  listTitle: { fontSize: 18, fontWeight: 'bold' },
  addBtn: { backgroundColor: colors.primary, width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', elevation: 3 },
  taskCard: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 16, marginBottom: 12, elevation: 2, shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 5 },
  iconBox: { width: 44, height: 44, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 14 },
  taskInfo: { flex: 1 },
  taskTitle: { fontSize: 15, fontWeight: '600' },
  completedText: { textDecorationLine: 'line-through', opacity: 0.5 },
  taskTime: { fontSize: 12, marginTop: 3, fontWeight: '500' },
  emptyState: { alignItems: 'center', marginTop: 40, opacity: 0.7 },
  emptyText: { fontSize: 16, fontWeight: 'bold', marginTop: 10 },
  emptySub: { fontSize: 13, marginTop: 4 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { width: '88%', borderRadius: 20, padding: 25 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 18 },
  input: { borderRadius: 10, padding: 13, marginBottom: 12, fontSize: 15 },
  typeLabel: { fontSize: 13, marginBottom: 8, fontWeight: '600' },
  typeRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  typeChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 15 },
  cancelBtn: { padding: 10 },
  saveBtn: { backgroundColor: colors.primary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  cancelText: { fontWeight: 'bold' },
  saveText: { color: 'white', fontWeight: 'bold' },
});