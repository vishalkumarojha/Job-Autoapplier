import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Modal, TextInput, Alert, ActivityIndicator, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { firestore } from '../../services/firebase';
import colors from '../../constants/colors';
import BackHeader from '../../components/BackHeader';
import BottomNav from '../../components/BottomNav';

interface PasswordEntry {
  id: string;
  website: string;
  username: string;
  password: string;
  isVisible?: boolean;
}

function parseCSV(csv: string): Omit<PasswordEntry, 'id' | 'isVisible'>[] {
  const lines = csv.split('\n').map((l) => l.trim()).filter(Boolean);
  const headers = lines[0].toLowerCase().split(',');
  const wIdx = headers.findIndex((h) => h.includes('name') || h.includes('website') || h.includes('url') || h.includes('host'));
  const uIdx = headers.findIndex((h) => h.includes('username') || h.includes('user') || h.includes('login'));
  const pIdx = headers.findIndex((h) => h.includes('password') || h.includes('pass'));
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      website: cols[wIdx >= 0 ? wIdx : 0]?.trim() || 'Unknown',
      username: cols[uIdx >= 0 ? uIdx : 1]?.trim() || '',
      password: cols[pIdx >= 0 ? pIdx : 2]?.trim() || '',
    };
  }).filter((e) => e.website && e.password);
}

export default function PasswordManagerScreen({ navigation }: any) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [passwords, setPasswords] = useState<PasswordEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [importingCSV, setImportingCSV] = useState(false);
  const [isAddModalVisible, setAddModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());

  const [newWebsite, setNewWebsite] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const ref = () => firestore().collection('users').doc(user!.uid).collection('passwords');

  useEffect(() => {
    if (!user) return;
    const unsub = ref()
      .orderBy('createdAt', 'desc')
      .onSnapshot((snap) => {
        setPasswords(snap.docs.map((d) => ({ id: d.id, ...d.data() } as PasswordEntry)));
        setLoading(false);
      }, () => setLoading(false));
    return unsub;
  }, [user]);

  const handleAddPassword = async () => {
    if (!newWebsite || !newPassword) {
      Alert.alert('Missing Info', 'Website and Password are required.');
      return;
    }
    setSaving(true);
    try {
      await ref().add({
        website: newWebsite.trim(),
        username: newUsername.trim(),
        password: newPassword,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      setAddModalVisible(false);
      setNewWebsite(''); setNewUsername(''); setNewPassword('');
    } finally {
      setSaving(false);
    }
  };

  const importCSV = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'text/plain', '*/*'] });
      if (result.canceled) return;

      setImportingCSV(true);
      const asset = result.assets[0];
      const content = await FileSystem.readAsStringAsync(asset.uri);
      const parsed = parseCSV(content);

      if (parsed.length === 0) {
        Alert.alert('Parse Error', 'No valid entries found. Make sure columns include website/name, username, and password.');
        setImportingCSV(false);
        return;
      }

      // Batch write to Firestore
      const batch = firestore().batch();
      parsed.forEach((entry) => {
        const docRef = ref().doc();
        batch.set(docRef, { ...entry, createdAt: firestore.FieldValue.serverTimestamp() });
      });
      await batch.commit();

      Alert.alert('Import Complete', `${parsed.length} password(s) imported successfully!`);
    } catch (error) {
      Alert.alert('Import Failed', 'Could not read or parse the CSV file.');
    } finally {
      setImportingCSV(false);
    }
  };

  const deletePassword = (id: string) => {
    Alert.alert('Delete', 'Remove this password entry?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => ref().doc(id).delete() },
    ]);
  };

  const toggleVisible = (id: string) => {
    setVisibleIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied!', 'Password copied to clipboard.');
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <BackHeader
        title={`Password Vault (${passwords.length})`}
        navigation={navigation}
        rightElement={
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={[styles.btn, { backgroundColor: theme.card }]} onPress={importCSV} disabled={importingCSV}>
              {importingCSV
                ? <ActivityIndicator color={colors.primary} size="small" />
                : <><Ionicons name="cloud-upload-outline" size={15} color={colors.primary} /><Text style={[styles.btnText, { color: colors.primary }]}>CSV</Text></>
              }
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }]} onPress={() => setAddModalVisible(true)}>
              <Ionicons name="add" size={15} color="white" />
              <Text style={[styles.btnText, { color: 'white' }]}>Add</Text>
            </TouchableOpacity>
          </View>
        }
      />

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={passwords}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="lock-closed-outline" size={60} color={theme.border} />
              <Text style={[styles.emptyTitle, { color: theme.textSub }]}>Vault is empty.</Text>
              <Text style={[styles.emptySub, { color: theme.textSub }]}>Add a password or import from CSV.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const isVisible = visibleIds.has(item.id);
            return (
              <View style={[styles.card, { backgroundColor: theme.card }]}>
                <View style={styles.cardTop}>
                  <View style={[styles.siteIcon, { backgroundColor: theme.iconBg }]}>
                    <Text style={[styles.siteInitial, { color: colors.primary }]}>
                      {item.website.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.siteInfo}>
                    <Text style={[styles.siteName, { color: theme.textMain }]} numberOfLines={1}>{item.website}</Text>
                    {item.username ? <Text style={[styles.siteUser, { color: theme.textSub }]} numberOfLines={1}>{item.username}</Text> : null}
                  </View>
                  <TouchableOpacity onPress={() => deletePassword(item.id)} style={{ padding: 6 }}>
                    <Ionicons name="trash-outline" size={18} color="#E74C3C" />
                  </TouchableOpacity>
                </View>

                <View style={[styles.divider, { backgroundColor: theme.border }]} />

                <View style={styles.pwRow}>
                  <Text style={[styles.pwText, { color: theme.textMain }]}>
                    {isVisible ? item.password : '••••••••'}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <TouchableOpacity onPress={() => toggleVisible(item.id)}>
                      <Ionicons name={isVisible ? 'eye-off-outline' : 'eye-outline'} size={20} color={theme.textSub} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => copy(item.password)}>
                      <Ionicons name="copy-outline" size={20} color={theme.textSub} />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          }}
        />
      )}

      {/* ADD MODAL */}
      <Modal visible={isAddModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textMain }]}>New Entry</Text>
              <TouchableOpacity onPress={() => setAddModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSub} />
              </TouchableOpacity>
            </View>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Website / App *" placeholderTextColor={theme.textSub} value={newWebsite} onChangeText={setNewWebsite} />
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Username / Email" placeholderTextColor={theme.textSub} value={newUsername} onChangeText={setNewUsername} />
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Password *" placeholderTextColor={theme.textSub} secureTextEntry value={newPassword} onChangeText={setNewPassword} />
            <TouchableOpacity style={styles.saveBtn} onPress={handleAddPassword} disabled={saving}>
              {saving ? <ActivityIndicator color="white" size="small" /> : <Text style={styles.saveText}>Save Entry</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      <BottomNav navigation={navigation} activeRoute="PasswordManager" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 18 },
  title: { fontSize: 26, fontWeight: 'bold' },
  subtitle: { fontSize: 13, marginTop: 3 },
  btn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, gap: 5 },
  btnText: { fontSize: 13, fontWeight: '600' },
  emptyState: { alignItems: 'center', marginTop: 60, paddingHorizontal: 30 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', marginTop: 15 },
  emptySub: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  card: { borderRadius: 16, padding: 18, marginBottom: 14, elevation: 2, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 8 },
  cardTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  siteIcon: { width: 42, height: 42, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 13 },
  siteInitial: { fontSize: 18, fontWeight: 'bold' },
  siteInfo: { flex: 1 },
  siteName: { fontSize: 16, fontWeight: '700' },
  siteUser: { fontSize: 13, marginTop: 2 },
  divider: { height: 1, marginVertical: 12 },
  pwRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pwText: { fontSize: 16, fontWeight: '500', letterSpacing: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 26, paddingBottom: 45 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  modalTitle: { fontSize: 20, fontWeight: 'bold' },
  input: { borderRadius: 12, padding: 14, marginBottom: 12, fontSize: 15 },
  saveBtn: { backgroundColor: colors.primary, paddingVertical: 15, borderRadius: 14, alignItems: 'center', marginTop: 10 },
  saveText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
});