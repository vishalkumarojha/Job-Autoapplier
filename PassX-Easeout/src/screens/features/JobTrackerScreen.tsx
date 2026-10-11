import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Modal, TextInput, Alert, Platform, StatusBar, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { firestore } from '../../services/firebase';
import colors from '../../constants/colors';

enum JobStatus {
  APPLIED = 'Applied',
  NO_RESPONSE = 'No Response',
  INTERVIEW = 'Interview',
  REJECTED = 'Rejected',
  OFFER = 'Offer',
}

interface JobApplication {
  id: string;
  companyName: string;
  role: string;
  link: string;
  deadline: string;
  status: JobStatus;
  notes?: string;
}

const STATUS_COLORS: Record<string, string> = {
  Applied: '#3498DB',
  'No Response': '#95A5A6',
  Interview: '#F1C40F',
  Rejected: '#E74C3C',
  Offer: '#2ECC71',
};

export default function JobTrackerScreen() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [jobs, setJobs] = useState<JobApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAddModalVisible, setAddModalVisible] = useState(false);
  const [selectedJob, setSelectedJob] = useState<JobApplication | null>(null);
  const [saving, setSaving] = useState(false);

  const [newCompany, setNewCompany] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newLink, setNewLink] = useState('');
  const [newDeadline, setNewDeadline] = useState('');
  const [newNotes, setNewNotes] = useState('');

  // ── Real-time Firestore listener ──────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const unsub = firestore()
      .collection('users').doc(user.uid).collection('jobs')
      .orderBy('createdAt', 'desc')
      .onSnapshot((snap) => {
        setJobs(snap.docs.map((d) => ({ id: d.id, ...d.data() } as JobApplication)));
        setLoading(false);
      }, () => setLoading(false));
    return unsub;
  }, [user]);

  const handleAddJob = async () => {
    if (!newCompany || !newRole) {
      Alert.alert('Missing Info', 'Company Name and Role are required.');
      return;
    }
    setSaving(true);
    try {
      await firestore()
        .collection('users').doc(user!.uid).collection('jobs')
        .add({
          companyName: newCompany,
          role: newRole,
          link: newLink,
          deadline: newDeadline || 'No Deadline',
          status: JobStatus.APPLIED,
          notes: newNotes,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
      setAddModalVisible(false);
      setNewCompany(''); setNewRole(''); setNewLink(''); setNewDeadline(''); setNewNotes('');
    } catch {
      Alert.alert('Error', 'Could not save job application.');
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (id: string, status: JobStatus) => {
    await firestore()
      .collection('users').doc(user!.uid).collection('jobs')
      .doc(id).update({ status });
    setSelectedJob((prev) => prev ? { ...prev, status } : prev);
  };

  const deleteJob = async (id: string) => {
    Alert.alert('Delete Job', 'Remove this application?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await firestore().collection('users').doc(user!.uid).collection('jobs').doc(id).delete();
          setSelectedJob(null);
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.textMain }]}>Job Applications</Text>
        <TouchableOpacity style={styles.addButton} onPress={() => setAddModalVisible(true)}>
          <Ionicons name="add" size={22} color="white" />
          <Text style={styles.addButtonText}>Add New</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={jobs}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 100, paddingHorizontal: 20 }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="briefcase-outline" size={60} color={theme.border} />
              <Text style={[styles.emptyText, { color: theme.textSub }]}>No applications yet.</Text>
              <Text style={[styles.emptySub, { color: theme.textSub }]}>Tap "Add New" to track your first job.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.card, { backgroundColor: theme.card }]}
              onPress={() => setSelectedJob(item)}
              activeOpacity={0.7}
            >
              <View style={styles.cardHeader}>
                <Text style={[styles.company, { color: theme.textMain }]}>{item.companyName}</Text>
                <View style={[styles.badge, { backgroundColor: STATUS_COLORS[item.status] }]}>
                  <Text style={styles.badgeText}>{item.status}</Text>
                </View>
              </View>
              <Text style={[styles.role, { color: theme.textSub }]}>{item.role}</Text>
              <View style={styles.cardFooter}>
                <Text style={[styles.deadline, { color: theme.textSub }]}>Due: {item.deadline}</Text>
                <Ionicons name="chevron-forward" size={16} color={theme.textSub} />
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* ADD MODAL */}
      <Modal visible={isAddModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.card }]}>
            <Text style={[styles.modalTitle, { color: theme.textMain }]}>New Application</Text>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Company Name *" placeholderTextColor={theme.textSub} value={newCompany} onChangeText={setNewCompany} />
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Role *" placeholderTextColor={theme.textSub} value={newRole} onChangeText={setNewRole} />
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Job Link (Optional)" placeholderTextColor={theme.textSub} value={newLink} onChangeText={setNewLink} />
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Deadline (e.g. April 1st)" placeholderTextColor={theme.textSub} value={newDeadline} onChangeText={setNewDeadline} />
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Notes (Optional)" placeholderTextColor={theme.textSub} value={newNotes} onChangeText={setNewNotes} />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setAddModalVisible(false)}>
                <Text style={[styles.cancelText, { color: theme.textSub }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleAddJob} disabled={saving}>
                {saving ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.saveText}>Save</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* DETAILS MODAL with status update */}
      <Modal visible={!!selectedJob} animationType="fade" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.detailsCard, { backgroundColor: theme.card }]}>
            {selectedJob && (
              <>
                <View style={[styles.detailsHeader, { backgroundColor: STATUS_COLORS[selectedJob.status] }]}>
                  <Text style={styles.detailsTitle}>{selectedJob.companyName}</Text>
                  <Text style={styles.detailsSubtitle}>{selectedJob.status}</Text>
                </View>
                <View style={[styles.detailsBody, { backgroundColor: theme.card }]}>
                  <Text style={[styles.label, { color: theme.textSub }]}>Role:</Text>
                  <Text style={[styles.value, { color: theme.textMain }]}>{selectedJob.role}</Text>
                  <Text style={[styles.label, { color: theme.textSub }]}>Deadline:</Text>
                  <Text style={[styles.value, { color: theme.textMain }]}>{selectedJob.deadline}</Text>
                  <Text style={[styles.label, { color: theme.textSub }]}>Notes:</Text>
                  <Text style={[styles.value, { color: theme.textMain }]}>{selectedJob.notes || 'No notes added.'}</Text>

                  <Text style={[styles.label, { color: theme.textSub, marginTop: 15 }]}>Update Status:</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                    {Object.values(JobStatus).map((s) => (
                      <TouchableOpacity
                        key={s}
                        style={[styles.statusChip, { backgroundColor: selectedJob.status === s ? STATUS_COLORS[s] : theme.border }]}
                        onPress={() => updateStatus(selectedJob.id, s)}
                      >
                        <Text style={{ color: selectedJob.status === s ? 'white' : theme.textMain, fontSize: 12, fontWeight: '600' }}>{s}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                <View style={[styles.detailsFooter, { borderTopColor: theme.border }]}>
                  <TouchableOpacity onPress={() => deleteJob(selectedJob.id)}>
                    <Text style={{ color: '#E74C3C', fontWeight: 'bold' }}>Delete</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSelectedJob(null)}>
                    <Text style={{ color: theme.textSub, fontWeight: 'bold' }}>Close</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 10, paddingBottom: 20 },
  title: { fontSize: 26, fontWeight: 'bold' },
  addButton: { flexDirection: 'row', backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, alignItems: 'center' },
  addButtonText: { color: 'white', fontWeight: 'bold', marginLeft: 5 },
  emptyState: { alignItems: 'center', marginTop: 60, paddingHorizontal: 30 },
  emptyText: { fontSize: 18, fontWeight: 'bold', marginTop: 15 },
  emptySub: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  card: { borderRadius: 14, padding: 16, marginBottom: 14, elevation: 2, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 6 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  company: { fontSize: 17, fontWeight: 'bold' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  badgeText: { color: 'white', fontSize: 11, fontWeight: 'bold' },
  role: { fontSize: 14, marginTop: 5 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, alignItems: 'center' },
  deadline: { fontSize: 12 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { width: '88%', borderRadius: 20, padding: 25 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 18, textAlign: 'center' },
  input: { borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 15 },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10, gap: 15 },
  cancelBtn: { padding: 10 },
  saveBtn: { backgroundColor: colors.primary, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  cancelText: { fontWeight: 'bold' },
  saveText: { color: 'white', fontWeight: 'bold' },
  detailsCard: { width: '88%', borderRadius: 20, overflow: 'hidden' },
  detailsHeader: { padding: 20, alignItems: 'center' },
  detailsTitle: { color: 'white', fontSize: 22, fontWeight: 'bold' },
  detailsSubtitle: { color: 'white', fontSize: 14, marginTop: 4, opacity: 0.9 },
  detailsBody: { padding: 20 },
  detailsFooter: { flexDirection: 'row', justifyContent: 'space-between', padding: 15, borderTopWidth: 1 },
  label: { fontSize: 13, marginTop: 10 },
  value: { fontSize: 16, fontWeight: '500' },
  statusChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
});