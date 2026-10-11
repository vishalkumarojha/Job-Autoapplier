import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  Modal, TextInput, KeyboardAvoidingView, Platform, Alert, ActivityIndicator, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { firestore } from '../../services/firebase';
import colors from '../../constants/colors';
import BackHeader from '../../components/BackHeader';
import BottomNav from '../../components/BottomNav';

interface Profile {
  id: string;
  platformName: string;
  accountName: string;
  email: string;
  link: string;
  type: 'github' | 'linkedin' | 'university' | 'portfolio' | 'other';
}

const getPlatformDetails = (type: string) => {
  switch (type.toLowerCase()) {
    case 'github':     return { icon: 'logo-github',   color: '#24292e', bg: '#F0F0F0' };
    case 'linkedin':   return { icon: 'logo-linkedin', color: '#0077b5', bg: '#E1F0F7' };
    case 'university': return { icon: 'school',        color: '#8E44AD', bg: '#F4ECF7' };
    default:           return { icon: 'globe-outline', color: colors.primary, bg: '#E8F6F3' };
  }
};

const guessType = (name: string): Profile['type'] => {
  const n = name.toLowerCase();
  if (n.includes('git')) return 'github';
  if (n.includes('linked')) return 'linkedin';
  if (n.includes('univ') || n.includes('portal') || n.includes('college')) return 'university';
  if (n.includes('portfolio') || n.includes('website')) return 'portfolio';
  return 'other';
};

export default function ProfilesScreen({ navigation }: any) {
  const { user } = useAuth();
  const { theme } = useTheme();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalVisible, setModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  const [newPlatform, setNewPlatform] = useState('');
  const [newAccount, setNewAccount] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newLink, setNewLink] = useState('');

  useEffect(() => {
    if (!user) return;
    const unsub = firestore()
      .collection('users').doc(user.uid).collection('profiles')
      .orderBy('createdAt', 'desc')
      .onSnapshot((snap) => {
        setProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
        setLoading(false);
      }, () => setLoading(false));
    return unsub;
  }, [user]);

  const handleAddProfile = async () => {
    if (!newPlatform || !newAccount) return;
    setSaving(true);
    try {
      await firestore()
        .collection('users').doc(user!.uid).collection('profiles')
        .add({
          platformName: newPlatform,
          accountName: newAccount,
          email: newEmail,
          link: newLink,
          type: guessType(newPlatform),
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
      setModalVisible(false);
      setNewPlatform(''); setNewAccount(''); setNewEmail(''); setNewLink('');
    } catch {
      Alert.alert('Error', 'Could not save profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (id: string) => {
    Alert.alert('Delete Profile', 'Remove this profile?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => firestore().collection('users').doc(user!.uid).collection('profiles').doc(id).delete(),
      },
    ]);
  };

  const copy = async (text: string, label: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', `${label} copied to clipboard.`);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <BackHeader
        title="Important Profiles"
        navigation={navigation}
        rightElement={
          <TouchableOpacity style={styles.addButton} onPress={() => setModalVisible(true)}>
            <Ionicons name="add" size={22} color="white" />
          </TouchableOpacity>
        }
      />

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={profiles}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 100 }}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="person-circle-outline" size={60} color={theme.border} />
              <Text style={[styles.emptyTitle, { color: theme.textSub }]}>No profiles yet.</Text>
              <Text style={[styles.emptySub, { color: theme.textSub }]}>Tap + to add GitHub, LinkedIn, etc.</Text>
            </View>
          }
          renderItem={({ item }) => {
            const { icon, color, bg } = getPlatformDetails(item.type);
            return (
              <View style={[styles.card, { backgroundColor: theme.card }]}>
                <View style={styles.cardTop}>
                  <View style={styles.brandRow}>
                    <View style={[styles.iconBox, { backgroundColor: bg }]}>
                      <Ionicons name={icon as any} size={24} color={color} />
                    </View>
                    <Text style={[styles.platformName, { color: theme.textMain }]}>{item.platformName}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {item.link ? (
                      <TouchableOpacity style={[styles.visitBtn, { backgroundColor: theme.iconBg }]} onPress={() => Linking.openURL(item.link)}>
                        <Text style={[styles.visitText, { color }]}>Visit</Text>
                        <Ionicons name="arrow-forward" size={13} color={color} />
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity onPress={() => handleDelete(item.id)}>
                      <Ionicons name="trash-outline" size={18} color="#E74C3C" />
                    </TouchableOpacity>
                  </View>
                </View>

                <View style={[styles.divider, { backgroundColor: theme.border }]} />

                <View style={styles.fieldRow}>
                  <View style={styles.fieldInfo}>
                    <Text style={styles.label}>USERNAME / ID</Text>
                    <Text style={[styles.value, { color: theme.textMain }]}>{item.accountName}</Text>
                  </View>
                  <TouchableOpacity onPress={() => copy(item.accountName, 'Username')}>
                    <Ionicons name="copy-outline" size={20} color={theme.textSub} />
                  </TouchableOpacity>
                </View>

                {item.email ? (
                  <View style={[styles.fieldRow, { marginTop: 14 }]}>
                    <View style={styles.fieldInfo}>
                      <Text style={styles.label}>REGISTERED EMAIL</Text>
                      <Text style={[styles.value, { color: theme.textMain }]}>{item.email}</Text>
                    </View>
                    <TouchableOpacity onPress={() => copy(item.email, 'Email')}>
                      <Ionicons name="copy-outline" size={20} color={theme.textSub} />
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            );
          }}
        />
      )}

      <Modal visible={isModalVisible} animationType="slide" transparent>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: theme.card }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.textMain }]}>Add New Profile</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}>
                <Ionicons name="close" size={24} color={theme.textSub} />
              </TouchableOpacity>
            </View>
            <Text style={[styles.inputLabel, { color: theme.textMain }]}>Platform *</Text>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="e.g. GitHub, Portfolio" placeholderTextColor={theme.textSub} value={newPlatform} onChangeText={setNewPlatform} />
            <Text style={[styles.inputLabel, { color: theme.textMain }]}>Username / ID *</Text>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="e.g. abhi-dev" placeholderTextColor={theme.textSub} value={newAccount} onChangeText={setNewAccount} />
            <Text style={[styles.inputLabel, { color: theme.textMain }]}>Email</Text>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="Email used for login" placeholderTextColor={theme.textSub} keyboardType="email-address" value={newEmail} onChangeText={setNewEmail} />
            <Text style={[styles.inputLabel, { color: theme.textMain }]}>Link</Text>
            <TextInput style={[styles.input, { backgroundColor: theme.inputBg, color: theme.textMain }]} placeholder="https://..." placeholderTextColor={theme.textSub} value={newLink} onChangeText={setNewLink} />
            <TouchableOpacity style={styles.saveBtn} onPress={handleAddProfile} disabled={saving}>
              {saving ? <ActivityIndicator color="white" /> : <Text style={styles.saveText}>Save Profile</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <BottomNav navigation={navigation} activeRoute="Profiles" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingVertical: 22 },
  title: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { fontSize: 14, marginTop: 4 },
  addButton: { backgroundColor: colors.primary, width: 48, height: 48, borderRadius: 16, justifyContent: 'center', alignItems: 'center', elevation: 4, shadowColor: colors.primary, shadowOpacity: 0.3, shadowRadius: 8 },
  emptyState: { alignItems: 'center', marginTop: 60, paddingHorizontal: 30 },
  emptyTitle: { fontSize: 18, fontWeight: 'bold', marginTop: 15 },
  emptySub: { fontSize: 14, marginTop: 6, textAlign: 'center' },
  card: { borderRadius: 20, padding: 20, marginBottom: 16, elevation: 2, shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 10 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  iconBox: { width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  platformName: { fontSize: 18, fontWeight: '700' },
  visitBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, paddingVertical: 5, borderRadius: 20 },
  visitText: { fontSize: 12, fontWeight: '700', marginRight: 4 },
  divider: { height: 1, marginVertical: 15 },
  fieldRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fieldInfo: { flex: 1 },
  label: { fontSize: 11, fontWeight: '700', color: '#A0A0A0', marginBottom: 4, letterSpacing: 0.5 },
  value: { fontSize: 15, fontWeight: '500' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalContent: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 22, fontWeight: 'bold' },
  inputLabel: { fontSize: 14, fontWeight: '600', marginBottom: 7, marginTop: 12 },
  input: { borderRadius: 12, padding: 14, fontSize: 15, marginBottom: 2, borderWidth: 1, borderColor: 'transparent' },
  saveBtn: { backgroundColor: colors.primary, paddingVertical: 15, borderRadius: 14, alignItems: 'center', marginTop: 25 },
  saveText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
});