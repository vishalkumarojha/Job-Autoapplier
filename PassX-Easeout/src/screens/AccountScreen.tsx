import React, { useState } from 'react';
import {
  View, Text, StyleSheet, Image, TouchableOpacity,
  ScrollView, Switch, Alert, ActivityIndicator, Platform, StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import colors from '../constants/colors';

export default function AccountScreen({ navigation }: any) {
  const { user, userProfile, logout, updateProfilePhoto } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [isNotificationsEnabled, setIsNotificationsEnabled] = useState(true);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const displayName =
    userProfile?.displayName || user?.displayName || user?.email?.split('@')[0] || 'User';
  const displayEmail = user?.email || '';
  const photoURL = userProfile?.photoURL || user?.photoURL;

  const handlePickPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please allow access to your photo library.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled) return;
    const uri = result.assets[0].uri;
    setUploadingPhoto(true);
    try {
      await updateProfilePhoto(uri);
      Alert.alert('Success', 'Profile photo updated!');
    } catch (e) {
      Alert.alert('Upload Failed', 'Could not upload photo. Please try again.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleLogout = () => {
    Alert.alert('Log Out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out', style: 'destructive',
        onPress: async () => {
          try { await logout(); }
          catch { Alert.alert('Error', 'Could not log out. Please try again.'); }
        },
      },
    ]);
  };

  const SettingItem = ({ icon, label, type = 'arrow', value, onToggle }: any) => (
    <TouchableOpacity
      style={[styles.settingItem, { borderBottomColor: theme.border }]}
      activeOpacity={0.7}
    >
      <View style={styles.settingLeft}>
        <View style={[styles.iconContainer, { backgroundColor: theme.iconBg }]}>
          <Ionicons name={icon} size={20} color={colors.primary} />
        </View>
        <Text style={[styles.settingLabel, { color: theme.textMain }]}>{label}</Text>
      </View>
      {type === 'toggle' ? (
        <Switch
          value={value}
          onValueChange={onToggle}
          trackColor={{ false: '#E0E0E0', true: colors.primary }}
          thumbColor="white"
        />
      ) : (
        <Ionicons name="chevron-forward" size={20} color="#C7C7CC" />
      )}
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={theme.textMain} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.textMain }]}>My Profile</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* PROFILE CARD */}
        <View style={[styles.profileCard, { backgroundColor: theme.card }]}>
          <View style={styles.avatarContainer}>
            {uploadingPhoto ? (
              <View style={[styles.avatar, { justifyContent: 'center', alignItems: 'center', backgroundColor: theme.border }]}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
              <Image
                source={photoURL ? { uri: photoURL } : { uri: 'https://i.pravatar.cc/300?img=12' }}
                style={styles.avatar}
              />
            )}
            <TouchableOpacity
              style={[styles.cameraBtn, { borderColor: theme.card }]}
              onPress={handlePickPhoto}
            >
              <Ionicons name="camera" size={16} color="white" />
            </TouchableOpacity>
          </View>
          <Text style={[styles.userName, { color: theme.textMain }]}>{displayName}</Text>
          <Text style={[styles.userEmail, { color: theme.textSub }]}>{displayEmail}</Text>

          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Text style={[styles.statNum, { color: theme.textMain }]}>—</Text>
              <Text style={[styles.statLabel, { color: theme.textSub }]}>Projects</Text>
            </View>
            <View style={[styles.statDivider, { backgroundColor: theme.border }]} />
            <View style={styles.stat}>
              <Text style={[styles.statNum, { color: theme.textMain }]}>—</Text>
              <Text style={[styles.statLabel, { color: theme.textSub }]}>Tasks Done</Text>
            </View>
            <View style={[styles.statDivider, { backgroundColor: theme.border }]} />
            <View style={styles.stat}>
              <Text style={[styles.statNum, { color: theme.textMain }]}>—</Text>
              <Text style={[styles.statLabel, { color: theme.textSub }]}>Goals</Text>
            </View>
          </View>
        </View>

        {/* PREFERENCES */}
        <Text style={[styles.sectionHeader, { color: theme.textSub }]}>Preferences</Text>
        <View style={[styles.settingsGroup, { backgroundColor: theme.card }]}>
          <SettingItem
            icon="moon-outline"
            label="Dark Mode"
            type="toggle"
            value={theme.isDark}
            onToggle={toggleTheme}
          />
          <SettingItem
            icon="notifications-outline"
            label="Notifications"
            type="toggle"
            value={isNotificationsEnabled}
            onToggle={setIsNotificationsEnabled}
          />
        </View>

        <Text style={[styles.sectionHeader, { color: theme.textSub }]}>Support</Text>
        <View style={[styles.settingsGroup, { backgroundColor: theme.card }]}>
          <SettingItem icon="help-circle-outline" label="Help Center" />
          <SettingItem icon="shield-checkmark-outline" label="Privacy Policy" />
          <SettingItem icon="lock-closed-outline" label="Change Password" />
        </View>

        <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
          <Ionicons name="log-out-outline" size={20} color="#FF3B30" />
          <Text style={styles.logoutText}>Log Out</Text>
        </TouchableOpacity>

        <Text style={[styles.versionText, { color: theme.textSub }]}>Version 1.0.0 • Ease Out</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15,
  },
  backBtn: { padding: 5 },
  headerTitle: { fontSize: 18, fontWeight: 'bold' },
  profileCard: {
    margin: 20, borderRadius: 20, padding: 25, alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 3,
  },
  avatarContainer: { position: 'relative', marginBottom: 15 },
  avatar: { width: 100, height: 100, borderRadius: 50 },
  cameraBtn: {
    position: 'absolute', bottom: 0, right: 0,
    backgroundColor: colors.primary, width: 32, height: 32,
    borderRadius: 16, justifyContent: 'center', alignItems: 'center', borderWidth: 2,
  },
  userName: { fontSize: 22, fontWeight: 'bold', marginBottom: 5 },
  userEmail: { fontSize: 14, marginBottom: 20 },
  statsRow: { flexDirection: 'row', width: '100%', justifyContent: 'space-between', paddingHorizontal: 10 },
  stat: { alignItems: 'center', flex: 1 },
  statNum: { fontSize: 18, fontWeight: 'bold' },
  statLabel: { fontSize: 12, marginTop: 2 },
  statDivider: { width: 1, height: '100%' },
  sectionHeader: {
    marginLeft: 20, marginBottom: 10, marginTop: 10,
    fontSize: 13, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 0.8,
  },
  settingsGroup: {
    marginHorizontal: 20, borderRadius: 16, overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 5, elevation: 2,
  },
  settingItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 16, paddingHorizontal: 20, borderBottomWidth: 1,
  },
  settingLeft: { flexDirection: 'row', alignItems: 'center' },
  iconContainer: {
    width: 32, height: 32, borderRadius: 8,
    justifyContent: 'center', alignItems: 'center', marginRight: 15,
  },
  settingLabel: { fontSize: 16, fontWeight: '500' },
  logoutBtn: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    marginTop: 30, marginBottom: 10, backgroundColor: '#FFF0F0',
    marginHorizontal: 20, paddingVertical: 15, borderRadius: 12,
  },
  logoutText: { color: '#FF3B30', fontWeight: 'bold', fontSize: 16, marginLeft: 8 },
  versionText: { textAlign: 'center', fontSize: 12, marginTop: 10 },
});