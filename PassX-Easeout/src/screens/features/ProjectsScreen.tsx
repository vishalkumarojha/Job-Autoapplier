import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Modal, ScrollView, TextInput, Alert, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { firestore } from '../../services/firebase';
import BottomNav from '../../components/BottomNav';
import colors from '../../constants/colors';

interface Project {
  id: string;
  title: string;
  description: string;
  problemStatement?: string;
  solution?: string;
  techStack: string[];
  results?: string;
  collaboration?: string;
  link?: string;
}

export default function ProjectsScreen({ navigation }: any) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [isAddModalVisible, setAddModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form State
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newProblem, setNewProblem] = useState('');
  const [newSolution, setNewSolution] = useState('');
  const [newTech, setNewTech] = useState('');
  const [newResults, setNewResults] = useState('');
  const [newCollab, setNewCollab] = useState('');
  const [newLink, setNewLink] = useState('');

  // ── Real-time Firestore listener ──────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    const unsub = firestore()
      .collection('users').doc(user.uid).collection('projects')
      .orderBy('createdAt', 'desc')
      .onSnapshot((snap) => {
        const data: Project[] = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() } as Project));
        setProjects(data);
        setLoading(false);
      }, () => setLoading(false));
    return unsub;
  }, [user]);

  const handleAddProject = async () => {
    if (!newTitle || !newDesc) {
      Alert.alert('Missing Info', 'Project Title and Description are required.');
      return;
    }
    setSaving(true);
    try {
      await firestore()
        .collection('users').doc(user!.uid).collection('projects')
        .add({
          title: newTitle,
          description: newDesc,
          problemStatement: newProblem,
          solution: newSolution,
          techStack: newTech.split(',').map((t) => t.trim()).filter(Boolean),
          results: newResults,
          collaboration: newCollab,
          link: newLink,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
      setAddModalVisible(false);
      setNewTitle(''); setNewDesc(''); setNewProblem(''); setNewSolution('');
      setNewTech(''); setNewResults(''); setNewCollab(''); setNewLink('');
    } catch {
      Alert.alert('Error', 'Could not save project. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProject = async (id: string) => {
    Alert.alert('Delete Project', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          await firestore()
            .collection('users').doc(user!.uid).collection('projects')
            .doc(id).delete();
          setSelectedProject(null);
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.textMain }]}>My Projects</Text>
        <TouchableOpacity style={styles.addButton} onPress={() => setAddModalVisible(true)}>
          <Ionicons name="add" size={22} color="white" />
          <Text style={styles.addButtonText}>Add Project</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={projects}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 110, paddingHorizontal: 20 }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="rocket-outline" size={60} color={theme.border} />
              <Text style={[styles.emptyText, { color: theme.textSub }]}>No projects yet.</Text>
              <Text style={[styles.emptySub, { color: theme.textSub }]}>Tap "Add Project" to create your first one.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.card, { backgroundColor: theme.card }]}
              activeOpacity={0.8}
              onPress={() => setSelectedProject(item)}
            >
              <View style={styles.cardHeader}>
                <Text style={[styles.projectTitle, { color: theme.textMain }]}>{item.title}</Text>
                <Ionicons name="chevron-forward" size={20} color={theme.textSub} />
              </View>
              <Text style={[styles.description, { color: theme.textSub }]} numberOfLines={2}>{item.description}</Text>
              <View style={styles.tagContainer}>
                {item.techStack.slice(0, 3).map((tag, i) => (
                  <View key={i} style={styles.tag}><Text style={styles.tagText}>{tag}</Text></View>
                ))}
                {item.techStack.length > 3 && (
                  <View style={styles.tag}><Text style={styles.tagText}>+{item.techStack.length - 3}</Text></View>
                )}
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      {/* ADD MODAL */}
      <Modal visible={isAddModalVisible} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={[styles.addModalContent, { backgroundColor: theme.card }]}>
            <View style={styles.modalHeaderRow}>
              <Text style={[styles.modalTitle, { color: theme.textMain }]}>New Project</Text>
              <TouchableOpacity onPress={() => setAddModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSub} />
              </TouchableOpacity>
            </View>
            <ScrollView>
              <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Project Title *" placeholderTextColor={theme.textSub} value={newTitle} onChangeText={setNewTitle} />
              <TextInput style={[styles.input, styles.textArea, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Description *" multiline placeholderTextColor={theme.textSub} value={newDesc} onChangeText={setNewDesc} />
              <TextInput style={[styles.input, styles.textArea, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Problem Statement" multiline placeholderTextColor={theme.textSub} value={newProblem} onChangeText={setNewProblem} />
              <TextInput style={[styles.input, styles.textArea, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Solution" multiline placeholderTextColor={theme.textSub} value={newSolution} onChangeText={setNewSolution} />
              <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Technologies (comma separated)" placeholderTextColor={theme.textSub} value={newTech} onChangeText={setNewTech} />
              <TextInput style={[styles.input, styles.textArea, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Results & Takeaways" multiline placeholderTextColor={theme.textSub} value={newResults} onChangeText={setNewResults} />
              <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Collaboration / Event" placeholderTextColor={theme.textSub} value={newCollab} onChangeText={setNewCollab} />
              <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Project Link (Optional)" placeholderTextColor={theme.textSub} value={newLink} onChangeText={setNewLink} />
            </ScrollView>
            <TouchableOpacity style={styles.saveBtn} onPress={handleAddProject} disabled={saving}>
              {saving ? <ActivityIndicator color="white" /> : <Text style={styles.saveText}>Save Project</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* DETAILS MODAL */}
      <Modal visible={!!selectedProject} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.detailsModalContent, { backgroundColor: theme.card }]}>
            {selectedProject && (
              <>
                <View style={styles.modalHeaderRow}>
                  <Text style={[styles.modalTitle, { flex: 1, color: theme.textMain }]}>{selectedProject.title}</Text>
                  <TouchableOpacity onPress={() => handleDeleteProject(selectedProject.id)} style={{ marginRight: 10 }}>
                    <Ionicons name="trash-outline" size={22} color="#E74C3C" />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setSelectedProject(null)}>
                    <Ionicons name="close-circle" size={28} color={theme.textSub} />
                  </TouchableOpacity>
                </View>
                <ScrollView showsVerticalScrollIndicator={false}>
                  <Text style={[styles.fullDescription, { color: theme.textSub }]}>{selectedProject.description}</Text>
                  <View style={styles.rowContainer}>
                    <View style={styles.column}>
                      <Text style={[styles.heading, { color: theme.textMain }]}>Problem</Text>
                      <Text style={[styles.bodyText, { color: theme.textSub }]}>{selectedProject.problemStatement || 'N/A'}</Text>
                    </View>
                    <View style={styles.column}>
                      <Text style={[styles.heading, { color: theme.textMain }]}>Solution</Text>
                      <Text style={[styles.bodyText, { color: theme.textSub }]}>{selectedProject.solution || 'N/A'}</Text>
                    </View>
                  </View>
                  <Text style={[styles.heading, { color: theme.textMain }]}>Tech Stack</Text>
                  <View style={styles.tagContainer}>
                    {selectedProject.techStack.map((tag, i) => (
                      <View key={i} style={styles.tag}><Text style={styles.tagText}>{tag}</Text></View>
                    ))}
                  </View>
                  <Text style={[styles.heading, { color: theme.textMain }]}>Results</Text>
                  <Text style={[styles.bodyText, { color: theme.textSub }]}>{selectedProject.results || 'N/A'}</Text>
                  <Text style={[styles.heading, { color: theme.textMain }]}>Collaboration</Text>
                  <Text style={[styles.bodyText, { color: theme.textSub }]}>{selectedProject.collaboration || 'N/A'}</Text>
                  <View style={{ height: 40 }} />
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>

      <BottomNav navigation={navigation} activeRoute="Projects" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 20 },
  title: { fontSize: 28, fontWeight: 'bold' },
  addButton: { flexDirection: 'row', backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, alignItems: 'center' },
  addButtonText: { color: 'white', fontWeight: 'bold', marginLeft: 5, fontSize: 13 },
  emptyState: { alignItems: 'center', marginTop: 60, paddingHorizontal: 30 },
  emptyText: { fontSize: 18, fontWeight: 'bold', marginTop: 15 },
  emptySub: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  card: { borderRadius: 16, padding: 20, marginBottom: 15, elevation: 3, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  projectTitle: { fontSize: 18, fontWeight: 'bold', flex: 1 },
  description: { fontSize: 14, marginBottom: 15, lineHeight: 20 },
  tagContainer: { flexDirection: 'row', flexWrap: 'wrap' },
  tag: { backgroundColor: '#E8F6F3', paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, marginRight: 8, marginBottom: 6 },
  tagText: { fontSize: 12, color: colors.primary, fontWeight: '600' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  addModalContent: { borderTopLeftRadius: 25, borderTopRightRadius: 25, padding: 25, height: '90%' },
  detailsModalContent: { borderTopLeftRadius: 25, borderTopRightRadius: 25, padding: 25, height: '85%' },
  modalHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  modalTitle: { fontSize: 20, fontWeight: 'bold' },
  fullDescription: { fontSize: 15, lineHeight: 22, marginBottom: 20 },
  rowContainer: { flexDirection: 'row', gap: 15, marginBottom: 10 },
  column: { flex: 1 },
  heading: { fontSize: 15, fontWeight: 'bold', marginBottom: 6, marginTop: 12 },
  bodyText: { fontSize: 14, lineHeight: 20 },
  input: { borderRadius: 10, padding: 12, marginBottom: 12, fontSize: 15 },
  textArea: { height: 80, textAlignVertical: 'top' },
  saveBtn: { backgroundColor: colors.primary, paddingVertical: 15, borderRadius: 12, alignItems: 'center', marginTop: 10 },
  saveText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
});