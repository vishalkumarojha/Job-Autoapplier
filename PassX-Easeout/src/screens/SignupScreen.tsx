import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BlurView } from 'expo-blur';
import CustomInput from '../components/CustomInput';
import CustomButton from '../components/CustomButton';
import colors from '../constants/colors';
import { RootStackParamList } from '../types/navigation';
import { useAuth } from '../context/AuthContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Signup'>;

const { height, width } = Dimensions.get('window');

const SignupScreen: React.FC<Props> = ({ navigation }) => {
  const { signup } = useAuth();
  const [name, setName] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const handleSignup = async () => {
    if (!name || !email || !password || !confirmPassword) {
      Alert.alert('Missing Fields', 'Please fill in all fields.');
      return;
    }
    if (password !== confirmPassword) {
      Alert.alert('Password Mismatch', 'Passwords do not match. Please re-enter.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Weak Password', 'Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    try {
      await signup(email, password, name);
      // Navigation handled automatically by AuthContext state change in App.tsx
    } catch (error: any) {
      const message = getFirebaseErrorMessage(error.code);
      Alert.alert('Sign Up Failed', message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <View style={styles.container}>

        {/* 1. BACKGROUND LAYER */}
        <View style={styles.backgroundContainer}>
          <Image
            source={{ uri: 'https://img.freepik.com/free-vector/mobile-login-concept-illustration_114360-83.jpg' }}
            style={styles.backgroundImage}
            resizeMode="cover"
          />
          <View style={styles.tealOverlay} />
        </View>

        {/* 2. HEADER TEXT */}
        <SafeAreaView style={styles.topSection}>
          <Text style={styles.headerText}>
            Create Your Account and Simplify Your Workday
          </Text>
        </SafeAreaView>

        {/* 3. GLASS CARD FORM */}
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardView}
        >
          <BlurView intensity={80} tint="light" style={styles.glassCard}>
            <View style={styles.cardContent}>

              <Text style={styles.title}>Sign up</Text>

              <View style={styles.loginRow}>
                <Text style={styles.lightText}>Already Have An Account? </Text>
                <TouchableOpacity onPress={() => navigation.navigate('Login')}>
                  <Text style={styles.linkText}>Log In</Text>
                </TouchableOpacity>
              </View>

              {/* Form Fields */}
              <CustomInput
                placeholder="Your full name"
                icon="person-outline"
                value={name}
                onChangeText={setName}
              />
              <CustomInput
                placeholder="Enter your email address"
                icon="mail-outline"
                value={email}
                onChangeText={setEmail}
              />
              <CustomInput
                placeholder="Password (min 6 characters)"
                icon="lock-closed-outline"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
              />
              <CustomInput
                placeholder="Confirm Password"
                icon="lock-closed-outline"
                secureTextEntry
                value={confirmPassword}
                onChangeText={setConfirmPassword}
              />

              <View style={styles.buttonSpacer}>
                {loading ? (
                  <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 10 }} />
                ) : (
                  <CustomButton title="Sign Up" onPress={handleSignup} />
                )}
              </View>

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
    case 'auth/email-already-in-use':
      return 'An account with this email already exists.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/weak-password':
      return 'Password is too weak. Please use at least 6 characters.';
    case 'auth/operation-not-allowed':
      return 'Email/password sign-up is not enabled.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.primary,
  },
  backgroundContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  backgroundImage: {
    width: width,
    height: height * 0.6,
    marginTop: 0,
    opacity: 0.6,
  },
  tealOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(36, 182, 184, 0.3)',
  },
  topSection: {
    flex: 1,
    paddingHorizontal: 30,
    paddingTop: 60,
  },
  headerText: {
    fontSize: 26,
    fontWeight: 'bold',
    color: colors.white,
    lineHeight: 36,
    textShadowColor: 'rgba(0, 0, 0, 0.1)',
    textShadowOffset: { width: 1, height: 1 },
    textShadowRadius: 5,
  },
  keyboardView: {
    width: '100%',
    justifyContent: 'flex-end',
    flex: 1,
  },
  glassCard: {
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    overflow: 'hidden',
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.85)',
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
  loginRow: {
    flexDirection: 'row',
    alignSelf: 'center',
    marginBottom: 20,
  },
  lightText: { color: colors.textLight },
  linkText: { color: colors.primary, fontWeight: 'bold' },
  buttonSpacer: { marginTop: 10 },
});

export default SignupScreen;