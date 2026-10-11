import React from 'react';
import { ActivityIndicator, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createNavigationContainerRef } from '@react-navigation/native';
import crashlytics from '@react-native-firebase/crashlytics';
import { requestNotificationPermission } from './src/services/NotificationService';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { registerPushToken } from './src/api/push';
import notifee, { EventType } from '@notifee/react-native';
import { getInitialSharedText, onSharedText } from './src/services/ShareIntent';
import { syncJobDeadlineNotification, syncJobFollowupNotification } from './src/services/NotificationService';
import { createFirestoreJobsRepository } from './src/data/jobs/firestore';

// Auth & Theme Contexts
import { AuthProvider, useAuth } from './src/context/AuthContext';
import { ThemeProvider } from './src/context/ThemeContext';

// Auth Screens
import WelcomeScreen from './src/screens/WelcomeScreen';
import LoginScreen from './src/screens/LoginScreen';
import SignupScreen from './src/screens/SignupScreen';

// Main Screens
import DashboardScreen from './src/screens/DashboardScreen';
import AccountScreen from './src/screens/AccountScreen';
import JobPipelineScreen from './src/screens/JobPipelineScreen';
import ResumeLibraryScreen from './src/screens/ResumeLibraryScreen';
import JobIntakeScreen from './src/screens/JobIntakeScreen';
import JobIntakeReviewScreen from './src/screens/JobIntakeReviewScreen';

// Feature Screens
import PasswordManagerScreen from './src/screens/features/PasswordManagerScreen';
import JobTrackerScreen from './src/screens/features/JobTrackerScreen';
import GoalsScreen from './src/screens/features/GoalsScreen';
import StudyPlannerScreen from './src/screens/features/StudyPlannerScreen';
import CalendarScreen from './src/screens/features/CalendarScreen';
import ProjectsScreen from './src/screens/features/ProjectsScreen';
import ProfilesScreen from './src/screens/features/ProfilesScreen';
import CustomSpacesScreen from './src/screens/features/CustomSpacesScreen';

import type { RootStackParamList } from './src/types/navigation';

const Stack = createNativeStackNavigator<RootStackParamList>();
const navigationRef = createNavigationContainerRef<RootStackParamList>();

function whenNavigationReady(action: () => void, attempt = 0) {
  if (navigationRef.isReady()) { action(); return; }
  if (attempt < 30) setTimeout(() => whenNavigationReady(action, attempt + 1), 100);
}

// ─── Crashlytics Error Boundary ───────────────────────────────────────────────

interface EBState { hasError: boolean; error: Error | null }

class CrashlyticsErrorBoundary extends React.Component<React.PropsWithChildren<{}>, EBState> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): EBState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    crashlytics().recordError(error);
    crashlytics().log(`ErrorBoundary: ${info.componentStack}`);
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={eb.container}>
          <Text style={eb.emoji}>💥</Text>
          <Text style={eb.title}>Something went wrong</Text>
          <Text style={eb.msg}>{this.state.error?.message}</Text>
          <TouchableOpacity style={eb.btn} onPress={() => this.setState({ hasError: false, error: null })}>
            <Text style={eb.btnText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const eb = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30, backgroundColor: '#fff' },
  emoji: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#222', marginBottom: 10 },
  msg: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 30 },
  btn: { backgroundColor: '#24B6B8', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 14 },
  btnText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
});

// ─── Root Navigator ───────────────────────────────────────────────────────────

function RootNavigator() {
  const { user, loading } = useAuth();

  React.useEffect(() => {
    if (!user) return;
    let active = true;
    void (async () => {
      const permitted = await requestNotificationPermission();
      if (!permitted || !active) return;
      const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
      if (projectId) {
        try {
          const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
          await registerPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android');
        } catch (error) { console.warn('[Push] registration unavailable'); }
      }
      const repository = createFirestoreJobsRepository(user.uid);
      const jobs = await repository.listJobs().catch(() => []);
      if (!active) return;
      await Promise.all(jobs.flatMap((job) => [syncJobDeadlineNotification(job), syncJobFollowupNotification(job)]));
    })();
    const sharedListener = onSharedText((text) => {
      if (user) whenNavigationReady(() => navigationRef.navigate('JobIntake', { initialText: text, initialSource: 'share_android' }));
    });
    const responseListener = Notifications.addNotificationResponseReceivedListener((response) => {
      const jobId = response.notification.request.content.data?.jobId;
      if (typeof jobId === 'string' && user) whenNavigationReady(() => navigationRef.navigate('JobPipeline', { jobId }));
    });
    const localListener = notifee.onForegroundEvent(({ type, detail }) => {
      const jobId = detail.notification?.data?.jobId;
      if (type === EventType.PRESS && typeof jobId === 'string' && user) whenNavigationReady(() => navigationRef.navigate('JobPipeline', { jobId }));
    });
    void notifee.getInitialNotification().then((initial) => {
      const jobId = initial?.notification.data?.jobId;
      if (typeof jobId === 'string' && user) whenNavigationReady(() => navigationRef.navigate('JobPipeline', { jobId }));
    });
    void getInitialSharedText().then((text) => {
      if (text && user) whenNavigationReady(() => navigationRef.navigate('JobIntake', { initialText: text, initialSource: 'share_android' }));
    });
    return () => { active = false; sharedListener.remove(); responseListener.remove(); localListener(); };
  }, [user]);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#24B6B8' }}>
        <ActivityIndicator size="large" color="white" />
      </View>
    );
  }

  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      {user == null ? (
        <>
          <Stack.Screen name="Welcome" component={WelcomeScreen} />
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="Signup" component={SignupScreen} />
        </>
      ) : (
        <>
          <Stack.Screen name="Dashboard" component={DashboardScreen} />
          <Stack.Screen name="PasswordManager" component={PasswordManagerScreen} />
          <Stack.Screen name="JobTracker" component={JobTrackerScreen} />
          <Stack.Screen name="JobPipeline" component={JobPipelineScreen} />
          <Stack.Screen name="JobIntake" component={JobIntakeScreen} />
          <Stack.Screen name="JobIntakeReview" component={JobIntakeReviewScreen} />
          <Stack.Screen name="ResumeLibrary" component={ResumeLibraryScreen} />
          <Stack.Screen name="Goals" component={GoalsScreen} />
          <Stack.Screen name="StudyPlan" component={StudyPlannerScreen} />
          <Stack.Screen name="Calendar" component={CalendarScreen} />
          <Stack.Screen name="Projects" component={ProjectsScreen} />
          <Stack.Screen name="Profiles" component={ProfilesScreen} />
          <Stack.Screen name="CustomSpaces" component={CustomSpacesScreen} />
          <Stack.Screen name="Account" component={AccountScreen} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  return (
    <CrashlyticsErrorBoundary>
      <AuthProvider>
        <ThemeProvider>
          <NavigationContainer ref={navigationRef}>
            <RootNavigator />
          </NavigationContainer>
        </ThemeProvider>
      </AuthProvider>
    </CrashlyticsErrorBoundary>
  );
}
