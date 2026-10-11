import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  Image,
  Dimensions,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BlurView } from 'expo-blur';
import CustomInput from '../components/CustomInput';
import CustomButton from '../components/CustomButton';
import colors from '../constants/colors';
import { RootStackParamList } from '../types/navigation';
import { useAuth } from '../context/AuthContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

const { width, height } = Dimensions.get('window');

const LoginScreen: React.FC<Props> = ({ navigation }) => {
  const { login } = useAuth();
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Missing Fields', 'Please enter your email and password.');
      return;
    }

    setLoading(true);
    try {
      await login(email, password);
      // Navigation handled automatically by AuthContext state change in App.tsx
    } catch (error: any) {
      const message = getFirebaseErrorMessage(error.code);
      Alert.alert('Login Failed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <View style={styles.container}>

        {/* 1. BACKGROUND DOODLE LAYER */}
        <View style={styles.backgroundContainer}>
          <Image
            source={{ uri: 'https://img.freepik.com/free-vector/privacy-policy-concept-illustration_114360-7853.jpg' }}
            style={styles.backgroundImage}
            resizeMode="cover"
          />
          <View style={styles.tealOverlay} />
        </View>

        {/* 2. HEADER TEXT */}
        <View style={styles.topSection}>
          <Text style={styles.headerText}>
            Log in to stay on top of your tasks and projects.
          </Text>
        </View>

        {/* 3. GLASS CARD */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardView}
        >
          <BlurView intensity={80} tint="light" style={styles.glassCard}>
            <View style={styles.cardContent}>

              <Text style={styles.title}>Login</Text>

              <View style={styles.row}>
                <Text style={styles.lightText}>Don't Have An Account? </Text>
                <TouchableOpacity onPress={() => navigation.navigate('Signup')}>
                  <Text style={styles.linkText}>Sign Up</Text>
                </TouchableOpacity>
              </View>

              <CustomInput
                placeholder="Enter your email address"
                icon="mail-outline"
                value={email}
                onChangeText={setEmail}
              />
              <CustomInput
                placeholder="Password"
                icon="lock-closed-outline"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
              />

              <TouchableOpacity style={styles.forgotPassword}>
                <Text style={styles.linkText}>Forgot Password?</Text>
              </TouchableOpacity>

              {loading ? (
                <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 10 }} />
              ) : (
                <CustomButton title="Login" onPress={handleLogin} />
              )}

            </View>
          </BlurView>
        </KeyboardAvoidingView>

      </View>
    </TouchableWithoutFeedback>
  );
};

// ─── Firebase Error Messages ───────────────────────────────────────────────────

function getFirebaseErrorMessage(code: string): string {
  switch (code) {
    case 'auth/user-not-found':
      return 'No account found with this email address.';
    case 'auth/wrong-password':
      return 'Incorrect password. Please try again.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    case 'auth/too-many-requests':
      return 'Too many failed attempts. Please try again later.';
    case 'auth/invalid-credential':
      return 'Invalid email or password. Please check your credentials.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.primary,
    justifyContent: 'space-between',
  },
  backgroundContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  backgroundImage: {
    width: width,
    height: height * 0.65,
    opacity: 0.8,
  },
  tealOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(36, 182, 184, 0.4)',
  },
  topSection: {
    flex: 1,
    paddingHorizontal: 30,
    paddingTop: 80,
    justifyContent: 'flex-start',
  },
  headerText: {
    fontSize: 28,
    fontWeight: 'bold',
    color: colors.white,
    lineHeight: 38,
    textShadowColor: 'rgba(0,0,0,0.1)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 5,
  },
  keyboardView: {
    width: '100%',
    justifyContent: 'flex-end',
  },
  glassCard: {
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden',
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
  },
  cardContent: {
    padding: 30,
    paddingBottom: 50,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.textDark,
    alignSelf: 'center',
    marginBottom: 5,
  },
  row: {
    flexDirection: 'row',
    alignSelf: 'center',
    marginBottom: 20,
  },
  lightText: { color: colors.textLight },
  linkText: { color: colors.primary, fontWeight: 'bold' },
  forgotPassword: { alignSelf: 'flex-end', marginVertical: 10 },
});

export default LoginScreen;